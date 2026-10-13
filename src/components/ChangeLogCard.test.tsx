import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import {
  bookkeepingChange, categoryFiledChange, importChange, stampChange, transferLinkChange, type ChangeDraft,
} from '../../shared/change-entries';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log';
import { ChangeLogCard, CHANGE_LOG_EMPTY, CHANGE_LOG_NO_MATCH, CHANGE_LOG_READ_FAILED } from './ChangeLogCard';

/** Local wall-clock moments, so times and day headings hold in any TZ. */
const at = (month: number, day: number, h: number, m: number) => new Date(2026, month, day, h, m);
const NOW = at(9, 12, 15, 0);
const CHECKING = { sfinId: 'ACT-1f2e', wfId: 'wf-checking', name: 'Checking' };
const CARD = { sfinId: 'ACT-9c8d', wfId: 'wf-citi', name: 'Citi Card' };
const item = (draft: ChangeDraft, when: Date, run?: string): ChangeLogItem => stampChange(draft, 'companion', when, run);
const imp = (n: number, when: Date, run: string) => item(importChange({
  account: CHECKING, txKey: `k${n}`, activityId: `act-${n}`, description: `KROGER #${n}`, amountCents: -1234,
  date: '2026-10-11', pending: false, activityType: 'WITHDRAWAL',
}), when, run);
const filed = (desc: string, when: Date, account = CARD) => item(categoryFiledChange({
  actor: 'auto', account, activityId: `f-${desc}`, description: desc, amountCents: -1080,
  before: { categoryId: 'cat-on', categoryName: 'Online Shopping' }, after: { categoryId: 'cat-pc', categoryName: 'Personal Care' },
  why: 'Amazon: Skincare',
}), when);
const log = (entries: ChangeLogItem[], extra: Partial<ChangeLogRead> = {}): ChangeLogRead =>
  ({ entries: [...entries].sort((a, b) => (a.at < b.at ? 1 : -1)), gaps: [], trimmed: 0, unreadable: [], ...extra });

const ENTRIES = () => [
  imp(1, at(9, 12, 14, 5), 'runA'), imp(2, at(9, 12, 14, 6), 'runA'),
  item(bookkeepingChange({ step: 'external-marker', account: CHECKING, activityIds: ['x'] }), at(9, 12, 14, 6), 'runA'),
  filed('AMAZON MKTPL*2K4', at(9, 11, 9, 12)),
  item(transferLinkChange(
    { account: CHECKING, txKey: 'k8', description: 'CITI AUTOPAY', amountCents: -46460, date: '2026-09-20', oldActivityId: 'o1' },
    { account: CARD, txKey: 'k9', description: 'PAYMENT THANK YOU', amountCents: 46460, date: '2026-09-20', oldActivityId: 'o2' },
  ), at(8, 20, 8, 0)),
];

const mount = (read: ChangeLogRead | null) => {
  const load = vi.fn(async () => read);
  render(<ChangeLogCard load={load} now={() => NOW} />);
  return load;
};
const rowTexts = () => Array.from(document.querySelectorAll('.sfin-log-row')).map((r) => r.textContent);

describe('ChangeLogCard', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists the last 30 days by day — time, summary, account, amount — with a run as one row', async () => {
    mount(log(ENTRIES()));
    await screen.findByText('Oct 12');
    expect(Array.from(document.querySelectorAll('.sfin-log-day')).map((d) => d.textContent)).toEqual(['Oct 12', 'Oct 11', 'Sep 20']);
    expect(rowTexts()).toEqual([
      '14:06Imported 2 transactions',
      '09:12Moved AMAZON MKTPL*2K4 from Online Shopping to Personal CareCiti Card-$10.80',
      '08:00Linked CITI AUTOPAY and PAYMENT THANK YOU as one transferChecking → Citi Card-$464.60',
    ]);
    expect(screen.getByText('1 background change not shown — Background lists it.')).toBeInTheDocument();
  });

  it('opens a row to why, before → after and who', async () => {
    mount(log(ENTRIES()));
    fireEvent.click(await screen.findByRole('button', { name: /Moved AMAZON MKTPL\*2K4/ }));
    const detail = document.querySelector('.sfin-log-detail')!;
    expect(within(detail as HTMLElement).getByText('Why: Amazon: Skincare')).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByText('Before → after: Online Shopping → Personal Care')).toBeInTheDocument();
    expect(detail.textContent).toContain('Automatic — the background sync · Oct 11, 9:12 AM');
  });

  it('opens a run to its transactions', async () => {
    mount(log(ENTRIES()));
    fireEvent.click(await screen.findByRole('button', { name: /Imported 2 transactions/ }));
    expect(Array.from(document.querySelectorAll('.sfin-log-run-line')).map((l) => l.textContent)).toEqual([
      '14:06Imported KROGER #2Checking-$12.34',
      '14:05Imported KROGER #1Checking-$12.34',
    ]);
  });

  it('filters by kind, account, period and words', async () => {
    mount(log(ENTRIES()));
    await screen.findByText('Oct 12');
    fireEvent.click(screen.getByRole('button', { name: 'Transfers' }));
    expect(rowTexts()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    expect(screen.getByText(CHANGE_LOG_NO_MATCH)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '90 days' }));
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'Citi Card' } });
    expect(rowTexts()).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Search changes'), { target: { value: 'personal care' } });
    expect(rowTexts()).toEqual([expect.stringContaining('Moved AMAZON MKTPL*2K4')]);
    fireEvent.click(screen.getByRole('button', { name: 'Background' }));
    fireEvent.change(screen.getByLabelText('Search changes'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: '' } });
    expect(rowTexts()).toEqual([expect.stringContaining('Marked 1 bookkeeping row')]);
  });

  it('heads the card with gaps, trims and unreadable buckets', async () => {
    mount(log([], {
      gaps: [{ at: at(9, 12, 8, 0).toISOString(), count: 3, reason: "couldn't save the log", writer: 'addon' }],
      trimmed: 5,
      unreadable: [{ writer: 'companion', month: '2026-10', paused: true }],
    }));
    expect(await screen.findByText("3 changes may be missing — couldn't save the log Oct 12.")).toBeInTheDocument();
    expect(screen.getByText('5 older changes were trimmed to keep the log small.')).toBeInTheDocument();
    expect(screen.getByText("The companion's log for October 2026 can't be read, so its new changes aren't being saved.")).toBeInTheDocument();
    expect(screen.getByText(CHANGE_LOG_EMPTY)).toBeInTheDocument();
  });

  it('says so when the log cannot be read', async () => {
    mount(null);
    expect(await screen.findByText(CHANGE_LOG_READ_FAILED)).toBeInTheDocument();
  });

  it('shows bank text as text, never as markup', async () => {
    mount(log([filed('<img src=x onerror=alert(1)>', at(9, 12, 9, 0))]));
    expect(await screen.findByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('search never matches bookkeeping entries, and All still hides them', async () => {
    mount(log(ENTRIES()));
    await screen.findByText('Oct 12');
    fireEvent.change(screen.getByLabelText('Search changes'), { target: { value: 'checking' } });
    expect(rowTexts().join('|')).not.toContain('bookkeeping');
    fireEvent.click(screen.getByRole('button', { name: 'Background' }));
    expect(screen.getByText(CHANGE_LOG_NO_MATCH)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search changes'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(rowTexts().join('|')).not.toContain('bookkeeping');
  });

  it('marks an entry Undo reversed (R2)', async () => {
    const e = { ...filed('VENMO', at(9, 12, 9, 0)), undone: { by: 'c9', at: at(9, 12, 10, 0).toISOString() } };
    mount(log([e]));
    const row = await screen.findByRole('button', { name: /Moved VENMO/ });
    expect(row.className).toContain('sfin-log-row--undone');
    expect(row.textContent).toContain('(undone)');
  });
});
