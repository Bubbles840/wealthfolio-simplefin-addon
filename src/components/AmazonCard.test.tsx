import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { AmazonCard } from './AmazonCard';
import type { SecretsStore } from '../utils/secrets';

const catalog = (...names: string[]) =>
  names.map((name) => ({
    name, parent: null as string | null, icon: null, color: null,
    hasBudget: false, hasSpend: false,
  }));

function makeProps(over: Partial<React.ComponentProps<typeof AmazonCard>> = {}) {
  const store = {
    getAmazonConfig: vi.fn(async () => null as any),
    setAmazonConfig: vi.fn(async () => {}),
    getAmazonLabels: vi.fn(async () => ({} as any)),
  } as unknown as SecretsStore;
  return {
    store,
    cardId: 'amazon',
    guideId: 'amazon-guide',
    open: true,
    guideOpen: false,
    onToggle: vi.fn(),
    onToggleGuide: vi.fn(),
    categories: catalog('Housing', 'Groceries', 'Shopping'),
    ...over,
  };
}

describe('AmazonCard', () => {
  it('summarises being unconfigured as charges staying uncategorized', async () => {
    // The summary is what a collapsed card shows, so it has to answer "is this
    // doing anything for me?" rather than just naming the feature.
    const props = makeProps({ open: false });
    render(<AmazonCard {...props} />);
    expect(await screen.findByText(/Not set up/i)).toBeTruthy();
  });

  it('saves the three fields the companion needs', async () => {
    const props = makeProps();
    render(<AmazonCard {...props} />);
    await screen.findByLabelText(/IMAP server/i);

    fireEvent.change(screen.getByLabelText(/Mailbox address/i), {
      target: { value: 'receipts@gmail.com' },
    });
    fireEvent.change(screen.getByLabelText(/App password/i), {
      target: { value: 'abcd efgh ijkl mnop' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Amazon Settings/i }));

    await waitFor(() => expect(props.store.setAmazonConfig).toHaveBeenCalled());
    expect((props.store.setAmazonConfig as any).mock.calls[0][0]).toMatchObject({
      enabled: true,
      host: 'imap.gmail.com',
      user: 'receipts@gmail.com',
      password: 'abcd efgh ijkl mnop',
    });
  });

  it('cannot be saved half-filled', async () => {
    // A host and a username with no password would have the companion attempt a
    // login every sync and log a failure every time.
    const props = makeProps();
    render(<AmazonCard {...props} />);
    const save = await screen.findByRole('button', { name: /Save Amazon Settings/i });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it('takes the app password as a password field, not plain text', async () => {
    const props = makeProps();
    render(<AmazonCard {...props} />);
    const input = await screen.findByLabelText(/App password/i);
    expect(input.getAttribute('type')).toBe('password');
  });

  it('lists the labels Amazon has actually used, with where each was filed', async () => {
    // The user's OWN label set. Amazon's vocabulary is unpublished and probably
    // hundreds long; a household sees a dozen, and those are the dozen worth
    // showing.
    const props = makeProps();
    props.store.getAmazonLabels = vi.fn(async () => ({
      'Lawn & Garden': { category: 'Housing', matched: true },
      'Industrial & Scientific': { category: 'Shopping', matched: false },
    })) as any;
    render(<AmazonCard {...props} />);

    expect(await screen.findByText('Lawn & Garden')).toBeTruthy();
    // The unmatched one is called out, because it is the only actionable case.
    expect(screen.getByText(/no rule yet/i)).toBeTruthy();
    const select = screen.getByLabelText(/category for Amazon's Lawn & Garden/i);
    expect((select as HTMLSelectElement).value).toBe('Housing');
  });

  it('saves an override for a label that was filed wrong', async () => {
    const props = makeProps();
    props.store.getAmazonConfig = vi.fn(async () => ({
      host: 'imap.gmail.com', user: 'r@g.com', password: 'x',
    })) as any;
    props.store.getAmazonLabels = vi.fn(async () => ({
      'Lawn & Garden': { category: 'Housing', matched: true },
    })) as any;
    render(<AmazonCard {...props} />);

    const select = await screen.findByLabelText(/category for Amazon's Lawn & Garden/i);
    fireEvent.change(select, { target: { value: 'Groceries' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Amazon Settings/i }));

    await waitFor(() => expect(props.store.setAmazonConfig).toHaveBeenCalled());
    expect((props.store.setAmazonConfig as any).mock.calls[0][0].labelOverrides)
      .toEqual({ 'Lawn & Garden': 'Groceries' });
  });

  it('reports how many labels still need a rule, so the summary is actionable', async () => {
    const props = makeProps({ open: false });
    props.store.getAmazonConfig = vi.fn(async () => ({
      host: 'imap.gmail.com', user: 'r@g.com', password: 'x',
    })) as any;
    props.store.getAmazonLabels = vi.fn(async () => ({
      'Lawn & Garden': { category: 'Housing', matched: true },
      'Industrial & Scientific': { category: 'Shopping', matched: false },
    })) as any;
    render(<AmazonCard {...props} />);
    expect(await screen.findByText(/1 need.? a rule/i)).toBeTruthy();
  });

  it('offers parent categories only, since Wealthfolio budgets at parent level', async () => {
    const props = makeProps({
      categories: [
        ...catalog('Housing'),
        { name: 'Rent', parent: 'Housing', icon: null, color: null, hasBudget: false, hasSpend: false },
      ],
    });
    props.store.getAmazonLabels = vi.fn(async () => ({
      'Lawn & Garden': { category: 'Housing', matched: true },
    })) as any;
    render(<AmazonCard {...props} />);
    const select = await screen.findByLabelText(/category for Amazon's Lawn & Garden/i);
    const values = [...(select as HTMLSelectElement).options].map((o) => o.value);
    expect(values).toContain('Housing');
    expect(values).not.toContain('Rent');
  });

  it('explains that this cannot double-count a purchase', async () => {
    // The first question anyone asks: emails arrive before the charge, so does
    // the purchase get counted twice? It does not — order emails only label a
    // charge SimpleFin already imported — and the card says so where the user is
    // deciding whether to turn it on.
    const props = makeProps({ guideOpen: true });
    render(<AmazonCard {...props} />);
    expect(await screen.findByText(/Nothing here creates transactions/i)).toBeTruthy();
  });

  it('says why a separate mailbox, where the user is typing the password', async () => {
    const props = makeProps({ guideOpen: true });
    render(<AmazonCard {...props} />);
    expect(await screen.findByText(/nothing but Amazon receipts/i)).toBeTruthy();
  });
});
