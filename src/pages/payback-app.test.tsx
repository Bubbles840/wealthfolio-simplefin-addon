import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PAYBACK_NOT_IN_SPENDING } from '../../shared/payback-copy';
import { paybackFromApp } from '../utils/app-payback';
import { SyncPage } from './SyncPage';
import { makeProps } from './test-props';

vi.mock('../utils/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/sync')>();
  return {
    INTERVAL_SKIP_MESSAGE: actual.INTERVAL_SKIP_MESSAGE,
    runSync: vi.fn(async () => ({ imported: 0, skipped: 0, errors: [] })),
    applyBalanceAdjustment: vi.fn(async () => {}),
    applyBaselineCorrection: vi.fn(async () => {}),
  };
});
// The runner is the add-on's own (src/utils/app-payback.test.ts); here, what the page does with its answer.
vi.mock('../utils/app-payback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/app-payback')>();
  return { ...actual, paybackFromApp: vi.fn() };
});

const FILED = 'Filed as a payback under Restaurants — it takes $14 off your Food & Dining spending.';
const row = (id: string, over: Record<string, unknown> = {}) => ({
  activityId: id, date: '2026-10-09', amountCents: 1400, description: `Row ${id}`, accountName: 'PNC Checking', direction: 'in', ...over,
});

/** The page on a Wealthfolio 3.9 host (`v38`: one that refuses the 3.9 calls) with this companion. */
function page(opts: { companion?: string | null; v38?: boolean } = {}) {
  const props = makeProps();
  props.ctx.api.spending = {
    searchCashActivities: vi.fn(async () => {
      if (opts.v38) throw new Error("Unknown addon host API method 'spending.searchCashActivities'");
      return { items: [], totalCount: 0 };
    }),
    getCategories: vi.fn(async () => [{ kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-rest', key: 'r', name: 'Restaurants', path: 'Food & Dining / Restaurants' }]),
  };
  props.store.getCompanionVersion = vi.fn(async () => (opts.companion === undefined ? '1.62.0' : opts.companion));
  props.store.getUiState = vi.fn(async () => ({ activeTab: 'overview', checklistDismissed: true }));
  props.store.getUncategorizedStatus = vi.fn(async () => ({
    count: 2, asOf: '2026-10-14T12:00:00.000Z', rows: [row('a', { paybackEligible: true }), row('b')],
  }));
  render(<SyncPage {...props} />);
  return props;
}

async function openList() {
  fireEvent.click(await screen.findByRole('button', { name: /^2 need/i }));
  await screen.findByText('Row a');
  // Let the offer's check (one probe) settle.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function fileRowA() {
  fireEvent.click(await screen.findByRole('button', { name: /It's a payback… Row a/ }));
  fireEvent.change(await screen.findByRole('combobox', { name: 'Spending category' }), { target: { value: 'cat-rest' } });
  fireEvent.click(screen.getByRole('button', { name: 'File it' }));
}

describe("It's a payback… on the needs-a-category list (W11)", () => {
  it('is offered on the rows the companion marks, and only those', async () => {
    page();
    await openList();
    expect(await screen.findByRole('button', { name: /It's a payback… Row a, \$14\.00 on 2026-10-09/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /It's a payback… Row b/ })).toBeNull();
  });

  it.each<[string, Parameters<typeof page>[0]]>([
    ['no companion: nothing could undo it', { companion: null }],
    ['a 1.61 companion, which turns a payback back into a deposit', { companion: '1.61.0' }],
    ['a Wealthfolio 3.8 host, which cannot confirm the filing', { v38: true }],
  ])('is hidden with %s', async (_name, opts) => {
    page(opts);
    await openList();
    expect(screen.queryByRole('button', { name: /It's a payback/ })).toBeNull();
  });

  it('a filed row leaves the list and the count at once, and the list says what happened', async () => {
    vi.mocked(paybackFromApp).mockResolvedValueOnce({ kind: 'filed', message: `${FILED}\nUndo it from Telegram: /changes.` });
    const props = page();
    await openList();
    await fileRowA();
    expect(await screen.findByText(FILED)).toBeInTheDocument();
    expect(screen.getByText('Undo it from Telegram: /changes.')).toBeInTheDocument();
    expect(screen.queryByText('Row a')).toBeNull();
    expect(screen.getByText('Row b')).toBeInTheDocument();
    const tile = (await screen.findByText('Needs a category')).closest('.sfin-tile');
    expect(tile?.textContent).toContain('1');
    expect(paybackFromApp).toHaveBeenCalledWith(props.ctx, props.store, { activityId: 'a', categoryId: 'cat-rest' });
  });

  it('a refused row stays, with the reason under it', async () => {
    vi.mocked(paybackFromApp).mockResolvedValueOnce({ kind: 'refused', message: PAYBACK_NOT_IN_SPENDING });
    page();
    await openList();
    await fileRowA();
    expect(await screen.findByText(PAYBACK_NOT_IN_SPENDING)).toBeInTheDocument();
    expect(screen.getByText('Row a')).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByText('Needs a category').closest('.sfin-tile') as HTMLElement).getByText('2')).toBeInTheDocument());
  });

  it('the list\'s payback line clears when a new publish arrives (W11-C)', async () => {
    vi.mocked(paybackFromApp).mockResolvedValueOnce({ kind: 'filed', message: `${FILED}\nUndo it from Telegram: /changes.` });
    const props = page();
    await openList();
    await fileRowA();
    expect(await screen.findByText(FILED)).toBeInTheDocument();
    props.store.getUncategorizedStatus = vi.fn(async () => ({
      count: 1, asOf: '2026-10-14T13:00:00.000Z', rows: [row('b')],
    }));
    fireEvent.click(screen.getByRole('tab', { name: /settings/i }));
    fireEvent.click(await screen.findByRole('tab', { name: /home/i }));
    await screen.findByText('Needs a category');
    if (!screen.queryByText('Row b')) fireEvent.click(await screen.findByRole('button', { name: /^1 need/i }));
    await screen.findByText('Row b');
    // The line is cleared by an effect keyed on the publish time, one render
    // after the new rows show: wait for it (failed on CI's runner, 2026-10-18).
    await waitFor(() => expect(screen.queryByText(FILED)).toBeNull());
  });
});
