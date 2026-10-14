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

describe('AccountList: why an account is off (2c)', () => {
  it('an "off by" chip opens the explanation in place, and never opens the account', () => {
    const onOpenAccount = vi.fn();
    const { container } = render(
      <AccountList mapping={mapping} balances={balances} sfinNames={sfinNames} wfNames={wfNames} onOpenAccount={onOpenAccount}
        renderExplanation={(wfId) => <div>why {wfId}</div>} />,
    );
    const chip = container.querySelector('button.sfin-audit-chip')!;
    expect(chip.textContent).toContain('off by $36.10');
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(chip);
    expect(screen.getByText('why wf-b')).toBeInTheDocument();
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(chip).toHaveAttribute('aria-controls', 'sfin-audit-s2');
    fireEvent.keyDown(chip, { key: 'Enter' });
    expect(onOpenAccount).not.toHaveBeenCalled();
    fireEvent.click(chip);
    expect(screen.queryByText('why wf-b')).toBeNull();
  });

  it('labels the opened panel, drops it when a resync clears the drift, and never makes "not checked" a button', () => {
    const props = { mapping, sfinNames, wfNames, onOpenAccount: () => {}, renderExplanation: (id: string) => <div>why {id}</div> };
    const { container, rerender } = render(<AccountList {...props} balances={balances} />);
    fireEvent.click(container.querySelector('button.sfin-audit-chip')!);
    expect(screen.getByRole('region', { name: 'Why Citi Double Cash is off' })).toBeInTheDocument();
    rerender(<AccountList {...props} balances={{ ...balances, s2: { ...balances.s2, drift: null, measured: true } }} />);
    expect(screen.queryByText('why wf-b')).toBeNull();
    const unchecked = { s1: { ...balances.s1, drift: null, measured: undefined }, s2: { ...balances.s2, drift: null, measured: undefined } };
    const second = render(<AccountList {...props} balances={unchecked} />);
    expect(second.container.querySelectorAll('button.sfin-audit-chip')).toHaveLength(0);
  });

  it('keeps the chip a label without an explainer, and "in sync" is never a button', () => {
    const { container, unmount } = render(
      <AccountList mapping={mapping} balances={balances} sfinNames={sfinNames} wfNames={wfNames} onOpenAccount={() => {}} />,
    );
    expect(container.querySelector('button.sfin-audit-chip')).toBeNull();
    unmount();
    const explained = render(
      <AccountList mapping={mapping} balances={balances} sfinNames={sfinNames} wfNames={wfNames} onOpenAccount={() => {}}
        renderExplanation={() => null} />,
    );
    expect(explained.container.querySelectorAll('button.sfin-audit-chip')).toHaveLength(1);
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
