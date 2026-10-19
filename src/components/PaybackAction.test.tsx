import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildTxStory } from '../../shared/tx-story';
import type { PaybackCategory } from '../../shared/payback-app';
import type { AppPaybackOutcome } from '../../shared/payback-app-file';
import {
  PAYBACK_APP_CATEGORIES_FAILED, PAYBACK_NOT_IN_SPENDING, PAYBACK_PICK, PAYBACK_UNREACHABLE, paybackAppUnfiled,
} from '../../shared/payback-copy';
import { PaybackAction, type AppPaybackActions } from './PaybackAction';
import { TxStoryView } from './TxStory';

const EMOJI = /\p{Extended_Pictographic}/u;
const CATS: PaybackCategory[] = [
  { id: 'cat-rest', name: 'Restaurants', parentName: 'Food & Dining', path: 'Food & Dining / Restaurants', kind: 'expense' },
  { id: 'cat-auto', name: 'Auto', parentName: null, path: 'Auto', kind: 'expense' },
];
const FILED: AppPaybackOutcome = {
  kind: 'filed', message: 'Filed as a payback under Restaurants — it takes $14 off your Food & Dining spending.\nUndo it from Telegram: /changes.',
};
const actions = (file: AppPaybackActions['file'] = vi.fn(async () => FILED), categories: AppPaybackActions['categories'] = vi.fn(async () => CATS)) => ({ file, categories });

async function pick(categoryId = 'cat-rest') {
  fireEvent.click(screen.getByRole('button', { name: /It's a payback…/ }));
  const select = await screen.findByRole('combobox', { name: 'Spending category' });
  fireEvent.change(select, { target: { value: categoryId } });
}

describe('PaybackAction', () => {
  it("opens the picker under Telegram's line, with the spending categories by path; nothing is filed until File it", async () => {
    const a = actions();
    const { container } = render(<PaybackAction activityId="act-7" actions={a} />);
    fireEvent.click(screen.getByRole('button', { name: "It's a payback…" }));
    expect(await screen.findByText(PAYBACK_PICK)).toBeInTheDocument();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a category', 'Food & Dining / Restaurants', 'Auto']);
    expect(screen.getByRole('button', { name: 'File it' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(PAYBACK_PICK)).toBeNull();
    expect(a.file).not.toHaveBeenCalled();
    expect(EMOJI.test(container.textContent ?? '')).toBe(false);
  });

  it('files once, busy while it runs, with the row as the story showed it, and hands the outcome up', async () => {
    let finish!: (o: AppPaybackOutcome) => void;
    const file = vi.fn(() => new Promise<AppPaybackOutcome>((r) => { finish = r; }));
    const onOutcome = vi.fn();
    render(<PaybackAction activityId="act-7" shown="abcd1234" actions={actions(file)} onOutcome={onOutcome} />);
    await pick();
    const go = screen.getByRole('button', { name: 'File it' });
    fireEvent.click(go);
    fireEvent.click(go);
    expect(file).toHaveBeenCalledTimes(1);
    expect(file).toHaveBeenCalledWith('act-7', 'cat-rest', 'abcd1234');
    expect(go).toBeDisabled();
    expect(go).toHaveAttribute('aria-busy', 'true');
    await act(async () => { finish(FILED); });
    expect(onOutcome).toHaveBeenCalledWith(FILED);
    expect(screen.queryByText(PAYBACK_PICK)).toBeNull();
  });

  it('says a refusal under the row in the list, line by line, and can be tried again', async () => {
    const message = `${paybackAppUnfiled('Restaurants')}\nUndo it from Telegram: /changes.`;
    render(<PaybackAction inlineStatus activityId="act-7" label="VENMO CASHOUT, $14.00 on 2026-10-09" actions={actions(vi.fn(async () => ({ kind: 'partial' as const, message })))} />);
    expect(screen.getByRole('button', { name: "It's a payback… VENMO CASHOUT, $14.00 on 2026-10-09" })).toBeInTheDocument();
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'File it' }));
    expect(await screen.findByText(paybackAppUnfiled('Restaurants'))).toBeInTheDocument();
    expect(screen.getByText('Undo it from Telegram: /changes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /It's a payback…/ })).toBeInTheDocument();
  });

  it("says it couldn't reach Wealthfolio when filing throws", async () => {
    render(<PaybackAction inlineStatus activityId="act-7" actions={actions(vi.fn(async () => { throw new Error('offline'); }))} />);
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'File it' }));
    expect(await screen.findByText(PAYBACK_UNREACHABLE)).toBeInTheDocument();
  });

  it('says so when the categories cannot be read, and offers the button again', async () => {
    render(<PaybackAction activityId="act-7" actions={actions(vi.fn(), vi.fn(async () => { throw new Error('offline'); }))} />);
    fireEvent.click(screen.getByRole('button', { name: "It's a payback…" }));
    expect(await screen.findByText(PAYBACK_APP_CATEGORIES_FAILED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "It's a payback…" })).toBeEnabled();
  });
});

describe('PaybackAction — focus, loading and empty states (W11-C)', () => {
  it('focuses the select when the picker opens, and the action button again after Cancel', async () => {
    render(<PaybackAction activityId="act-7" actions={actions()} />);
    fireEvent.click(screen.getByRole('button', { name: "It's a payback…" }));
    const select = await screen.findByRole('combobox', { name: 'Spending category' });
    // Focus moves in an effect AFTER the render these queries see, so each check
    // waits for it: asserted at once, it failed on CI's slower runner (2026-10-18).
    await waitFor(() => expect(select).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('button', { name: "It's a payback…" })).toHaveFocus());
  });

  it('focuses the action button again after a refusal', async () => {
    render(<PaybackAction inlineStatus activityId="act-7" actions={actions(vi.fn(async () => ({ kind: 'refused' as const, message: PAYBACK_NOT_IN_SPENDING })))} />);
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'File it' }));
    await screen.findByText(PAYBACK_NOT_IN_SPENDING);
    await waitFor(() => expect(screen.getByRole('button', { name: /It's a payback…/ })).toHaveFocus());
  });

  it('leaves out the aria-label while "Loading categories…" shows (the name is then what it says)', async () => {
    let release!: (c: PaybackCategory[]) => void;
    const categories = vi.fn(() => new Promise<PaybackCategory[]>((r) => { release = r; }));
    render(<PaybackAction activityId="act-7" label="VENMO CASHOUT, $14.00" actions={actions(vi.fn(), categories)} />);
    fireEvent.click(screen.getByRole('button', { name: /It's a payback… VENMO CASHOUT/ }));
    const loading = screen.getByRole('button', { name: 'Loading categories…' });
    expect(loading).not.toHaveAttribute('aria-label');
    await act(async () => { release(CATS); });
  });

  it('says "No spending categories to pick from." when there are none, and keeps the button', async () => {
    render(<PaybackAction activityId="act-7" actions={actions(vi.fn(), vi.fn(async () => []))} />);
    fireEvent.click(screen.getByRole('button', { name: "It's a payback…" }));
    expect(await screen.findByText('No spending categories to pick from.')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('button', { name: "It's a payback…" })).toBeEnabled();
  });

  it('marks Cancel busy while filing', async () => {
    let finish!: (o: AppPaybackOutcome) => void;
    render(<PaybackAction activityId="act-7" actions={actions(vi.fn(() => new Promise<AppPaybackOutcome>((r) => { finish = r; })))} />);
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'File it' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('aria-busy', 'true');
    await act(async () => { finish(FILED); });
  });

  it('on a story: one wrapper, not a .sfin-why-remove inside a .sfin-why-remove', () => {
    const story = buildTxStory({
      now: new Date('2026-10-14T15:00:00Z'),
      row: { activityId: 'act-7', note: 'VENMO CASHOUT · TRN-77', absCents: 1400, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking', accountType: 'CASH' },
      feed: { sfinAccountId: 'sfin-chk' }, partner: null, category: null, history: [],
    });
    const { container } = render(<TxStoryView story={story} entries={[]} actions={{ companionVersion: '1.62.0', payback: actions() }} onChanged={() => {}} payback={{ activityId: 'act-7', fingerprint: 'abcd1234' }} />);
    expect(container.querySelector('.sfin-why-remove .sfin-why-remove')).toBeNull();
    expect(container.querySelector('.sfin-why-remove')).not.toBeNull();
  });
});

describe('"It\'s a payback…" on a story in the app', () => {
  const story = buildTxStory({
    now: new Date('2026-10-14T15:00:00Z'),
    row: { activityId: 'act-7', note: 'VENMO CASHOUT · TRN-77', absCents: 1400, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking', accountType: 'CASH' },
    feed: { sfinAccountId: 'sfin-chk' }, partner: null, category: null, history: [],
  });
  const OFFER = { activityId: 'act-7', fingerprint: 'abcd1234' };

  it('is offered only with the actions and a row that qualifies', () => {
    const { unmount } = render(<TxStoryView story={story} entries={[]} actions={{ companionVersion: '1.62.0', payback: actions() }} onChanged={() => {}} payback={OFFER} />);
    expect(screen.getByRole('button', { name: "It's a payback…" })).toBeInTheDocument();
    unmount();
    const { unmount: again } = render(<TxStoryView story={story} entries={[]} actions={{ companionVersion: '1.62.0' }} onChanged={() => {}} payback={OFFER} />);
    expect(screen.queryByRole('button', { name: /It's a payback/ })).toBeNull();
    again();
    render(<TxStoryView story={story} entries={[]} actions={{ companionVersion: '1.62.0', payback: actions() }} onChanged={() => {}} />);
    expect(screen.queryByRole('button', { name: /It's a payback/ })).toBeNull();
  });

  it('says what happened, line by line, and reads the story again', async () => {
    const onChanged = vi.fn();
    const a = actions(vi.fn(async () => ({ kind: 'refused' as const, message: PAYBACK_NOT_IN_SPENDING })));
    render(<TxStoryView story={story} entries={[]} actions={{ companionVersion: '1.62.0', payback: a }} onChanged={onChanged} payback={OFFER} />);
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'File it' }));
    expect(await screen.findByText(PAYBACK_NOT_IN_SPENDING)).toBeInTheDocument();
    expect(a.file).toHaveBeenCalledWith('act-7', 'cat-rest', 'abcd1234');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('keeps the filed words when the re-read story no longer offers it', async () => {
    const view = (payback?: typeof OFFER) => (
      <TxStoryView story={story} entries={[]} actions={{ companionVersion: '1.62.0', payback: a }} onChanged={() => {}} {...(payback ? { payback } : {})} />
    );
    const a = actions();
    const { rerender } = render(view(OFFER));
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'File it' }));
    expect(await screen.findByText('Undo it from Telegram: /changes.')).toBeInTheDocument();
    rerender(view());
    expect(screen.getByText('Filed as a payback under Restaurants — it takes $14 off your Food & Dining spending.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /It's a payback/ })).toBeNull();
  });
});
