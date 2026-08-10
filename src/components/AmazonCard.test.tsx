import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { AmazonCard, useAmazonDraft } from './AmazonCard';
import type { SecretsStore } from '../utils/secrets';

const catalog = (...names: string[]) =>
  names.map((name) => ({
    name, parent: null as string | null, icon: null, color: null,
    hasBudget: false, hasSpend: false,
  }));

/**
 * The card's draft now lives in the PAGE, not in the card — it holds an IMAP app
 * password and the Advanced panel is unmounted on every tab switch, so state
 * owned here was silently destroyed (see `useAmazonDraft`). These tests keep
 * asserting against the card itself, so this stands in for the page: it calls the
 * hook and hands the result down, exactly as `SyncPage` does.
 */
function Harness({ store, ...rest }: { store: SecretsStore } & Record<string, any>) {
  const amazon = useAmazonDraft(store);
  return <AmazonCard {...(rest as any)} amazon={amazon} />;
}

function makeProps(over: Record<string, any> = {}) {
  const store = {
    getAmazonConfig: vi.fn(async () => null as any),
    setAmazonConfig: vi.fn(async () => {}),
    getAmazonLabels: vi.fn(async () => ({} as any)),
    getAmazonMailStatus: vi.fn(async () => null as any),
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
    render(<Harness {...props} />);
    expect(await screen.findByText(/Not set up/i)).toBeTruthy();
  });

  it('saves the three fields the companion needs', async () => {
    const props = makeProps();
    render(<Harness {...props} />);
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

  it('confirms a save with an ok-toned status line, and no emoji in the words', async () => {
    // This message used to open with a ✅, which was its ONLY success signal —
    // the div carried no tone class at all. Dropping the emoji without giving it
    // a tone would have left it the one status line in the addon that says
    // nothing about whether what just happened went well.
    const EMOJI = /\p{Extended_Pictographic}/u;
    const props = makeProps();
    render(<Harness {...props} />);
    await screen.findByLabelText(/IMAP server/i);
    fireEvent.change(screen.getByLabelText(/Mailbox address/i), {
      target: { value: 'receipts@gmail.com' },
    });
    fireEvent.change(screen.getByLabelText(/App password/i), {
      target: { value: 'abcd efgh ijkl mnop' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Amazon settings/i }));

    const status = await screen.findByRole('status');
    expect(status.className).toContain('sfin-status--ok');
    expect(status.className).not.toContain('sfin-status--err');
    expect(status.textContent).toMatch(/^Saved\./);
    expect(status.textContent).not.toMatch(EMOJI);
  });

  it('says out loud that something is unsaved, and stops once it is saved', async () => {
    // The card had no dirty signal at all, so an app password typed and not saved
    // looked exactly like one that had been. The pill is only there while
    // something IS pending: its appearing is the notification, its going away the
    // confirmation.
    const props = makeProps();
    render(<Harness {...props} />);
    await screen.findByLabelText(/IMAP server/i);
    expect(screen.queryByText(/You have unsaved changes/i)).toBeNull();

    fireEvent.change(screen.getByLabelText(/Mailbox address/i), {
      target: { value: 'receipts@gmail.com' },
    });
    fireEvent.change(screen.getByLabelText(/App password/i), {
      target: { value: 'abcd efgh ijkl mnop' },
    });
    expect(screen.getByText(/You have unsaved changes/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Save Amazon settings/i }));
    await waitFor(() =>
      expect(screen.queryByText(/You have unsaved changes/i)).toBeNull());
  });

  it('cannot be saved half-filled', async () => {
    // A host and a username with no password would have the companion attempt a
    // login every sync and log a failure every time.
    const props = makeProps();
    render(<Harness {...props} />);
    const save = await screen.findByRole('button', { name: /Save Amazon Settings/i });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it('takes the app password as a password field, not plain text', async () => {
    const props = makeProps();
    render(<Harness {...props} />);
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
    render(<Harness {...props} />);

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
    render(<Harness {...props} />);

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
    render(<Harness {...props} />);
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
    render(<Harness {...props} />);
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
    render(<Harness {...props} />);
    expect(await screen.findByText(/Nothing here creates transactions/i)).toBeTruthy();
  });

  it('says why a separate mailbox, where the user is typing the password', async () => {
    const props = makeProps({ guideOpen: true });
    render(<Harness {...props} />);
    expect(await screen.findByText(/nothing but Amazon receipts/i)).toBeTruthy();
  });
});

describe('AmazonCard unparsed-mail warning', () => {
  // Amazon changed its email format on 2026-08-07 and the companion silently
  // mis-filed order confirmations for two days — the parser leaves unreadable
  // mail unread and counts it, but that count used to reach only a server log
  // line nobody reads. This surfaces it in the card so it can't be missed.
  const EMOJI = /\p{Extended_Pictographic}/u;

  function configuredProps(over: Record<string, any> = {}) {
    const props = makeProps(over);
    props.store.getAmazonConfig = vi.fn(async () => ({
      host: 'imap.gmail.com', user: 'r@g.com', password: 'x',
    })) as any;
    return props;
  }

  it('warns with the count when the companion reports unparsed mail', async () => {
    const props = configuredProps();
    props.store.getAmazonMailStatus = vi.fn(async () => ({ unparsed: 2, asOf: '2026-08-08T12:00:00.000Z' })) as any;
    render(<Harness {...props} />);

    const warning = await screen.findByText(/2 recent emails could not be read/i);
    expect(warning.textContent).toMatch(/Amazon may have changed their email format/i);
    expect(warning.textContent).toMatch(/stay unread in the mailbox/i);
    expect(warning.textContent).toMatch(/stay uncategorized until this addon gets an update/i);
    expect(warning.textContent).not.toMatch(EMOJI);
    expect(warning.closest('.sfin-error')).toBeTruthy();
  });

  it('uses the singular for exactly one unparsed message', async () => {
    const props = configuredProps();
    props.store.getAmazonMailStatus = vi.fn(async () => ({ unparsed: 1, asOf: '2026-08-08T12:00:00.000Z' })) as any;
    render(<Harness {...props} />);
    expect(await screen.findByText(/1 recent email could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/1 recent emails/i)).toBeNull();
  });

  it('shows nothing when the status is null — version skew must look like no problem', async () => {
    const props = configuredProps();
    props.store.getAmazonMailStatus = vi.fn(async () => null) as any;
    render(<Harness {...props} />);
    await screen.findByLabelText(/IMAP server/i);
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  it('shows nothing when unparsed is 0 — a fixed format must clear the warning', async () => {
    const props = configuredProps();
    props.store.getAmazonMailStatus = vi.fn(async () => ({ unparsed: 0, asOf: '2026-08-08T12:00:00.000Z' })) as any;
    render(<Harness {...props} />);
    await screen.findByLabelText(/IMAP server/i);
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  it('shows nothing when the feature is not configured, even if a stale status remains', async () => {
    const props = makeProps({ open: false });
    props.store.getAmazonMailStatus = vi.fn(async () => ({ unparsed: 3, asOf: '2026-08-08T12:00:00.000Z' })) as any;
    render(<Harness {...props} />);
    await screen.findByText(/Not set up/i);
    expect(screen.queryByText(/could not be read/i)).toBeNull();
  });

  it('mentions the unread count in the collapsed summary, so it cannot be hidden', async () => {
    const props = configuredProps({ open: false });
    props.store.getAmazonMailStatus = vi.fn(async () => ({ unparsed: 2, asOf: '2026-08-08T12:00:00.000Z' })) as any;
    render(<Harness {...props} />);
    expect(await screen.findByText(/2 emails unread/i)).toBeTruthy();
  });
});
