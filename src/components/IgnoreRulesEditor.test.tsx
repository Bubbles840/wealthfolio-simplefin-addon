import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { IgnoreRulesEditor, ALL_ACCOUNTS } from './IgnoreRulesEditor';
import type { IgnoreRule } from '../../shared/ignore-rules';
import type { SimplefinAccount } from '../../shared/types';

const accounts = [{ id: 'sfin-cash', name: 'Cash Account' }, { id: 'sfin-chk', name: 'Checking' }];
const sweep: IgnoreRule = { pattern: 'SWEEP FROM CORE FUND', matchType: 'contains', account: 'sfin-cash' };

// Noon UTC: the same calendar day in every timezone the tests run in.
const NOON = 1789214400;
const feed: SimplefinAccount[] = [
  {
    id: 'sfin-cash', name: 'Cash Account', currency: 'USD', balance: '5000.00', 'balance-date': NOON,
    transactions: [
      { id: 'T1', posted: NOON, amount: '2500.00', description: 'DIRECT DEPOSIT EMPLOYER PAYROLL' },
      { id: 'T2', posted: NOON, amount: '400.00', description: 'SWEEP FROM CORE FUND MONEY MARKET' },
      { id: 'T3', posted: NOON, amount: '-400.00', description: 'DIRECT DEBIT CARD AUTOPAY' },
    ],
  },
  {
    id: 'sfin-chk', name: 'Checking', currency: 'USD', balance: '10', 'balance-date': NOON,
    transactions: [{ id: 'C1', posted: NOON, amount: '5.00', description: 'SWEEP FROM CORE FUND ELSEWHERE' }],
  },
  {
    // Not mapped: the preview never reaches it.
    id: 'sfin-unmapped', name: 'Old', currency: 'USD', balance: '0', 'balance-date': NOON,
    transactions: [{ id: 'U1', posted: NOON, amount: '1.00', description: 'SWEEP FROM CORE FUND' }],
  },
];

const fill = (pattern: string, account?: string) => {
  fireEvent.change(screen.getByLabelText('Description pattern'), { target: { value: pattern } });
  if (account !== undefined) fireEvent.change(screen.getByLabelText('Account'), { target: { value: account } });
};

describe('IgnoreRulesEditor', () => {
  it('lists saved rules with their account and note', () => {
    render(<IgnoreRulesEditor rules={[{ ...sweep, note: 'core sweeps' }]} accounts={accounts} onChange={vi.fn()} />);
    expect(screen.getByTestId('ignore-rule')).toHaveTextContent('contains “SWEEP FROM CORE FUND” · Cash Account · core sweeps');
  });

  it('without aliases (no confirmed reconnection, or a companion that would not follow one) lets the rule be added on the new id', () => {
    // What the scheduled syncs will do: an exact-id rule on the old id reaches nothing new.
    const unaliased = [{ id: 'sfin-cash', name: 'Cash Account' }, { id: 'sfin-cash-old', name: 'Cash Account · …-old' }];
    render(<IgnoreRulesEditor rules={[{ ...sweep, account: 'sfin-cash-old' }]} accounts={unaliased} onChange={vi.fn()} companionVersion="1.66.0" />);
    fill('SWEEP FROM CORE FUND', 'sfin-cash');
    expect(screen.queryByText('You already have this rule.')).toBeNull();
  });

  it('shows a rule saved on a retired id under the account that replaced it, and knows it is the same rule', () => {
    const relinked = [{ id: 'sfin-cash', name: 'Cash Account', aliases: ['sfin-cash-old'] }, { id: 'sfin-chk', name: 'Checking' }];
    render(<IgnoreRulesEditor rules={[{ ...sweep, account: 'sfin-cash-old' }]} accounts={relinked} onChange={vi.fn()} />);
    expect(screen.getByTestId('ignore-rule')).toHaveTextContent('contains “SWEEP FROM CORE FUND” · Cash Account');
    expect(screen.getAllByRole('option', { name: 'Cash Account' })).toHaveLength(1);
    fill('SWEEP FROM CORE FUND', 'sfin-cash');
    expect(screen.getByText('You already have this rule.')).toBeInTheDocument();
  });

  it('never saves a blank rule: Add stays disabled with no pattern, and with no account chosen', () => {
    const onChange = vi.fn(async () => {});
    render(<IgnoreRulesEditor rules={[]} accounts={accounts} onChange={onChange} />);
    const add = screen.getByRole('button', { name: 'Add rule…' });
    expect(add).toBeDisabled();
    fill('   ', 'sfin-cash');
    expect(add).toBeDisabled();
    fill('SWEEP FROM CORE FUND', '');
    expect(add).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('makes the account a choice: none is preselected, and "All synced accounts" is one option', () => {
    render(<IgnoreRulesEditor rules={[]} accounts={accounts} onChange={vi.fn()} />);
    const select = screen.getByLabelText('Account') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'Choose an account…', 'All synced accounts', 'Cash Account', 'Checking',
    ]);
  });

  it('says why a match-everything regex is refused, and will not add it', () => {
    render(<IgnoreRulesEditor rules={[]} accounts={accounts} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Match type'), { target: { value: 'regex' } });
    fill('.*', ALL_ACCOUNTS);
    expect(screen.getByRole('alert')).toHaveTextContent(/ignore every transaction/);
    expect(screen.getByRole('button', { name: 'Add rule…' })).toBeDisabled();
  });

  it('saves only after the inline confirmation, then clears the form', async () => {
    const onChange = vi.fn(async () => {});
    render(<IgnoreRulesEditor rules={[]} accounts={accounts} onChange={onChange} />);
    fill(' SWEEP FROM CORE FUND ', 'sfin-cash');
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'core sweeps' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule…' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('ignore-confirm')).toHaveTextContent(/Cash Account/);

    fireEvent.click(screen.getByRole('button', { name: 'Yes, ignore these' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([{ ...sweep, note: 'core sweeps' }]));
    await waitFor(() => expect((screen.getByLabelText('Description pattern') as HTMLInputElement).value).toBe(''));
  });

  it('stores "All synced accounts" as a rule with no account', async () => {
    const onChange = vi.fn(async () => {});
    render(<IgnoreRulesEditor rules={[]} accounts={accounts} onChange={onChange} />);
    fill('SWEEP TO CORE', ALL_ACCOUNTS);
    fireEvent.click(screen.getByRole('button', { name: 'Add rule…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, ignore these' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([{ pattern: 'SWEEP TO CORE', matchType: 'contains' }]));
  });

  it('shows the reason when the save is refused, and keeps the draft', async () => {
    const onChange = vi.fn(async () => { throw new Error("The list of ignore rules can't be read, so nothing was changed."); });
    render(<IgnoreRulesEditor rules={[]} accounts={accounts} onChange={onChange} />);
    fill('SWEEP', 'sfin-cash');
    fireEvent.click(screen.getByRole('button', { name: 'Add rule…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, ignore these' }));
    expect(await screen.findByText(/can't be read/)).toBeInTheDocument();
    expect((screen.getByLabelText('Description pattern') as HTMLInputElement).value).toBe('SWEEP');
  });

  it('removes a rule only after a second click', async () => {
    const other: IgnoreRule = { pattern: 'SWEEP TO CORE FUND', matchType: 'contains', account: 'sfin-cash' };
    const onChange = vi.fn(async () => {});
    render(<IgnoreRulesEditor rules={[sweep, other]} accounts={accounts} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Remove ignore rule contains “SWEEP FROM/ }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, import these again' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([other]));
  });

  it('is read-only over a list it cannot read', () => {
    render(<IgnoreRulesEditor rules={[]} accounts={accounts} onChange={vi.fn()} unreadable />);
    expect(screen.getByText(/can’t be read/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Description pattern')).toBeNull();
  });

  it('previews what the draft would leave out, in its account only, after reading the feed once', async () => {
    const loadFeed = vi.fn(async () => ({ accounts: feed, errors: [] as string[] }));
    render(<IgnoreRulesEditor rules={[]} accounts={accounts} onChange={vi.fn()} loadFeed={loadFeed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview last 30 days' }));
    await screen.findByTestId('ignore-preview');
    expect(loadFeed).toHaveBeenCalledWith(30);

    fill('sweep from core', 'sfin-cash');
    const preview = screen.getByTestId('ignore-preview');
    expect(preview).toHaveTextContent('This rule matches 1 of 3 transactions in the last 30 days.');
    expect(preview).toHaveTextContent('400.00');
    expect(preview).not.toHaveTextContent('PAYROLL');

    fill('sweep from core', ALL_ACCOUNTS);
    // Every MAPPED account: Checking's row counts, the unmapped account's does not.
    expect(screen.getByTestId('ignore-preview')).toHaveTextContent('This rule matches 2 of 4 transactions');
    expect(loadFeed).toHaveBeenCalledTimes(1);
  });

  it('previews the saved rules when the form is empty, and caps the list', async () => {
    const many: SimplefinAccount = {
      ...feed[0],
      transactions: Array.from({ length: 15 }, (_, i) => ({ id: `S${i}`, posted: NOON, amount: '1.00', description: 'SWEEP FROM CORE FUND' })),
    };
    render(<IgnoreRulesEditor rules={[sweep]} accounts={accounts} onChange={vi.fn()} loadFeed={async () => ({ accounts: [many], errors: [] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview last 30 days' }));
    const preview = await screen.findByTestId('ignore-preview');
    expect(preview).toHaveTextContent('Your rules match 15 of 15 transactions');
    expect(preview.querySelectorAll('tr')).toHaveLength(12);
    expect(preview).toHaveTextContent('+3 more');
  });

  it('says why the preview could not be read', async () => {
    render(<IgnoreRulesEditor rules={[]} accounts={accounts} onChange={vi.fn()}
      loadFeed={async () => { throw new Error('SimpleFin allows 24 downloads a day'); }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview last 30 days' }));
    expect(await screen.findByText(/24 downloads a day/)).toBeInTheDocument();
  });

  it('shows what SimpleFin reported beside the preview, rather than a bare "matches 0"', async () => {
    render(<IgnoreRulesEditor rules={[sweep]} accounts={accounts} onChange={vi.fn()}
      loadFeed={async () => ({ accounts: [], errors: ['Connection to Fidelity may need attention'] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview last 30 days' }));
    await screen.findByTestId('ignore-preview');
    expect(screen.getByText(/SimpleFin reported: Connection to Fidelity may need attention/)).toBeInTheDocument();
  });

  describe('against a companion that does not know ignore rules yet', () => {
    it('says to update it first, and will not add a rule; stored rules still show', () => {
      render(<IgnoreRulesEditor rules={[sweep]} accounts={accounts} onChange={vi.fn()} companionVersion="1.65.0" />);
      expect(screen.getByText(/Update the companion to 1\.66\.0 or newer first/)).toBeInTheDocument();
      expect(screen.getByTestId('ignore-rule')).toHaveTextContent('SWEEP FROM CORE FUND');
      fill('SWEEP TO CORE FUND', 'sfin-cash');
      expect(screen.getByRole('button', { name: 'Add rule…' })).toBeDisabled();
    });

    it('is open with no companion, and with one that is new enough', () => {
      for (const version of [null, '1.66.0']) {
        const { unmount } = render(<IgnoreRulesEditor rules={[]} accounts={accounts} onChange={vi.fn()} companionVersion={version} />);
        expect(screen.queryByText(/Update the companion/)).toBeNull();
        fill('SWEEP TO CORE FUND', 'sfin-cash');
        expect(screen.getByRole('button', { name: 'Add rule…' })).toBeEnabled();
        unmount();
      }
    });
  });
});
