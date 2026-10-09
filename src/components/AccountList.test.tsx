import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { AccountList, accountsSummary } from './AccountList';

const mapping = { s1: 'wf-a', s2: 'wf-b' };
const balances = {
  s1: { balance: 1842.17, currency: 'USD', date: 1760000000, drift: null, measured: true },
  s2: { balance: -94.93, currency: 'USD', date: 1760000000, drift: 36.1 },
} as any;
const sfinNames = { s1: 'Capital One Spend', s2: 'Citi Double Cash' };
const wfNames = { 'wf-a': 'Spend', 'wf-b': 'Citi' };

describe('AccountList', () => {
  it('lists each mapped account with its balance and state', () => {
    render(<AccountList mapping={mapping} balances={balances} sfinNames={sfinNames} wfNames={wfNames} onOpenAccount={() => {}} />);
    expect(screen.getByText('Capital One Spend')).toBeInTheDocument();
    expect(screen.getByText('$1,842.17')).toBeInTheDocument();
    expect(screen.getByText(/in sync/)).toBeInTheDocument();
    expect(screen.getByText(/off by \$36\.10/)).toBeInTheDocument();
  });

  it('opens the Wealthfolio account when a row is clicked', () => {
    const onOpenAccount = vi.fn();
    render(<AccountList mapping={mapping} balances={balances} sfinNames={sfinNames} wfNames={wfNames} onOpenAccount={onOpenAccount} />);
    fireEvent.click(screen.getByText('Citi Double Cash'));
    expect(onOpenAccount).toHaveBeenCalledWith('wf-b');
  });

  it('says so when nothing is mapped yet, instead of an empty frame', () => {
    render(<AccountList mapping={{}} balances={{}} sfinNames={{}} wfNames={{}} onOpenAccount={() => {}} />);
    expect(screen.getByText('No accounts mapped yet.')).toBeInTheDocument();
  });

  it('draws no frame or heading of its own — the Settings card it sits in has both', () => {
    const { container } = render(
      <AccountList mapping={mapping} balances={balances} sfinNames={sfinNames} wfNames={wfNames} onOpenAccount={() => {}} />,
    );
    expect(container.querySelector('.sfin-accts')).toBeNull();
    expect(screen.queryByText('Accounts')).toBeNull();
    expect(screen.getByText('Capital One Spend')).toBeInTheDocument();
  });
});

describe('accountsSummary', () => {
  it('names the count, and the difference only when there is one', () => {
    expect(accountsSummary(mapping, balances)).toBe('2 accounts · 1 off by $36.10');
    expect(accountsSummary({ s1: 'wf-a' }, balances)).toBe('1 account');
    expect(accountsSummary({}, {})).toBe('No accounts mapped');
  });

  it('counts several differing accounts without naming an amount', () => {
    const both = { ...balances, s1: { ...balances.s1, drift: 5 } };
    expect(accountsSummary(mapping, both)).toBe('2 accounts · 2 off');
  });
});
