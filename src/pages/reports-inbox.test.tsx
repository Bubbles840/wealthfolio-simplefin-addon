import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SyncPage } from './SyncPage';
import { makeProps } from './test-props';
import type { ReportEdition, ReportKind, ReportStore } from '../../shared/reports-archive';
import type { ReportsSeen, ReportsSeenRead } from '../../shared/reports-seen';

/**
 * The report inbox (project 5 R1, spec C), through the page that holds it:
 * the count on the Reports tab and its sub-tabs, "New" on unseen editions,
 * and opening a sub-tab marking it seen — one write.
 */
vi.mock('recharts', () => {
  const stub = (name: string) => (p: any) => React.createElement('div', { 'data-recharts': name }, p?.children ?? null);
  return {
    Area: stub('Area'), AreaChart: stub('AreaChart'), Bar: stub('Bar'), BarChart: stub('BarChart'),
    CartesianGrid: stub('CartesianGrid'), Cell: stub('Cell'), Line: stub('Line'),
    LineChart: stub('LineChart'), Pie: stub('Pie'), PieChart: stub('PieChart'),
    XAxis: stub('XAxis'), YAxis: stub('YAxis'),
  };
});
vi.mock('@wealthfolio/ui/chart', () => ({
  ChartContainer: (p: any) => React.createElement('div', null, p.children),
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
  ChartLegend: () => null,
  ChartLegendContent: () => null,
  ChartStyle: () => null,
}));
vi.mock('../utils/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/sync')>();
  return { INTERVAL_SKIP_MESSAGE: actual.INTERVAL_SKIP_MESSAGE, runSync: vi.fn(async () => ({ imported: 0, skipped: 0, errors: [] })) };
});

const edition = (kind: ReportKind, period: string, generatedAt: string): ReportEdition => ({
  kind, period, title: `Title ${period}`, generatedAt, text: `${kind} text ${period}`,
});
const REPORTS: Record<ReportKind, ReportStore> = {
  daily: {
    // Recomposed after every sync: never "new".
    live: { ...edition('daily', '2026-10-14', '2026-10-14T15:00:00.000Z'), title: 'Wednesday, Oct 14' },
    archive: [
      edition('daily', '2026-10-14', '2026-10-14T12:00:00.000Z'),
      edition('daily', '2026-10-13', '2026-10-13T12:00:00.000Z'),
      edition('daily', '2026-10-12', '2026-10-12T12:00:00.000Z'),
    ],
  },
  weekly: { live: null, archive: [edition('weekly', '2026-10-05', '2026-10-11T23:00:00.000Z')] },
  monthly: { live: null, archive: [edition('monthly', '2026-09', '2026-10-01T13:00:00.000Z')] },
};
/** Two dailies unread; the weekly and the monthly seen. */
const SEEN: ReportsSeen = { daily: '2026-10-12T12:00:00.000Z', weekly: '2026-10-11T23:00:00.000Z', monthly: '2026-10-01T13:00:00.000Z' };
const NEWEST: ReportsSeen = { daily: '2026-10-14T12:00:00.000Z', weekly: '2026-10-11T23:00:00.000Z', monthly: '2026-10-01T13:00:00.000Z' };

function page(read: () => Promise<ReportsSeenRead>, write: (seen: ReportsSeen) => Promise<void> = async () => {}, reports: Record<ReportKind, ReportStore> = REPORTS) {
  const props = makeProps();
  props.store.getUiState = vi.fn(async () => ({ activeTab: 'home' }));
  props.store.getReports = vi.fn(async (kind: ReportKind) => reports[kind]);
  props.store.getReportsSeen = vi.fn(read);
  props.store.setReportsSeen = vi.fn(write);
  return { props, ...render(<SyncPage {...props} />) };
}
const summaryOf = (title: string) => screen.getByText(title).closest('summary') as HTMLElement;

describe('the report inbox', () => {
  it('counts unread editions on the tab and the sub-tab, marks them New, and opening marks them seen with one write', async () => {
    const { props } = page(async () => ({ kind: 'ok', seen: SEEN }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Reports, 2 unread' }));
    expect(await screen.findByText('Title 2026-10-13')).toBeTruthy();
    await waitFor(() => expect(summaryOf('Title 2026-10-14').querySelector('.sfin-inbox-new')?.textContent).toBe('New'));
    expect(summaryOf('Title 2026-10-13').querySelector('.sfin-inbox-new')?.textContent).toBe('New');
    expect(summaryOf('Title 2026-10-12').querySelector('.sfin-inbox-new')).toBeNull();
    await waitFor(() => expect(props.store.setReportsSeen).toHaveBeenCalledTimes(1));
    expect(props.store.setReportsSeen).toHaveBeenCalledWith(NEWEST);
    // Seen now: the counts go; the markers stay for this visit.
    expect(await screen.findByRole('tab', { name: 'Reports' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Daily' })).toBeTruthy();
    expect(summaryOf('Title 2026-10-14').querySelector('.sfin-inbox-new')).toBeTruthy();
    // Back and forth: nothing new to write.
    fireEvent.click(screen.getByRole('tab', { name: 'Weekly' }));
    expect(await screen.findByText('Title 2026-10-05')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Daily' }));
    expect(await screen.findByText('Title 2026-10-13')).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(props.store.setReportsSeen).toHaveBeenCalledTimes(1);
    expect(summaryOf('Title 2026-10-14').querySelector('.sfin-inbox-new')).toBeNull();
  });

  it('shows the count on a sub-tab that is not open', async () => {
    page(async () => ({ kind: 'ok', seen: { daily: '2026-10-14T12:00:00.000Z', monthly: '2026-10-01T13:00:00.000Z' } }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Reports, 1 unread' }));
    expect(await screen.findByRole('tab', { name: 'Weekly, 1 unread' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Daily' })).toBeTruthy();
  });

  it.each<[string, ReportsSeenRead]>([
    ['a first run', { kind: 'absent' }],
    ['a document nothing can read', { kind: 'corrupt' }],
  ])('%s counts nothing as unread and writes the newest edition of each kind as seen', async (_what, read) => {
    const { props } = page(async () => read);
    await waitFor(() => expect(props.store.setReportsSeen).toHaveBeenCalledTimes(1));
    expect(props.store.setReportsSeen).toHaveBeenCalledWith(NEWEST);
    fireEvent.click(screen.getByRole('tab', { name: 'Reports' }));
    expect(await screen.findByText('Title 2026-10-13')).toBeTruthy();
    expect(document.querySelector('.sfin-inbox-new')).toBeNull();
    expect(document.querySelector('.sfin-inbox-badge')).toBeNull();
  });

  it('a failed write leaves the count as it is, and throws nothing', async () => {
    const { props } = page(async () => ({ kind: 'ok', seen: SEEN }), async () => { throw new Error('host'); });
    fireEvent.click(await screen.findByRole('tab', { name: 'Reports, 2 unread' }));
    await waitFor(() => expect(props.store.setReportsSeen).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('tab', { name: 'Reports, 2 unread' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Daily, 2 unread' })).toBeTruthy();
  });

  it('a host read that fails counts nothing and writes nothing', async () => {
    const { props } = page(async () => { throw new Error('host'); });
    await waitFor(() => expect(props.store.getReportsSeen).toHaveBeenCalled());
    // Let the rejection settle before anything is judged.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    fireEvent.click(screen.getByRole('tab', { name: 'Reports' }));
    expect(await screen.findByText('Title 2026-10-13')).toBeTruthy();
    expect(document.querySelector('.sfin-inbox-badge')).toBeNull();
    expect(props.store.setReportsSeen).not.toHaveBeenCalled();
  });

  it('does nothing more once the page is gone', async () => {
    let finish: () => void = () => {};
    const { props, unmount } = page(async () => ({ kind: 'ok', seen: SEEN }), () => new Promise<void>((resolve) => { finish = resolve; }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Reports, 2 unread' }));
    await waitFor(() => expect(props.store.setReportsSeen).toHaveBeenCalledTimes(1));
    const reads = (props.store.getReportsSeen as ReturnType<typeof vi.fn>).mock.calls.length;
    unmount();
    await act(async () => { finish(); await Promise.resolve(); await Promise.resolve(); });
    expect(props.store.setReportsSeen).toHaveBeenCalledTimes(1);
    expect((props.store.getReportsSeen as ReturnType<typeof vi.fn>).mock.calls.length).toBe(reads);
  });

  it('opening one kind keeps another device\'s newer time for another kind', async () => {
    let stored: ReportsSeen = SEEN;
    const { props } = page(async () => ({ kind: 'ok', seen: stored }));
    const tab = await screen.findByRole('tab', { name: 'Reports, 2 unread' });
    // Device B has since read the weekly further on.
    stored = { ...SEEN, weekly: '2026-10-20T00:00:00.000Z' };
    fireEvent.click(tab);
    await waitFor(() => expect(props.store.setReportsSeen).toHaveBeenCalledTimes(1));
    expect(props.store.setReportsSeen).toHaveBeenCalledWith({ ...NEWEST, weekly: '2026-10-20T00:00:00.000Z' });
  });

  it('a failed re-read before the write skips the write', async () => {
    let failing = false;
    const { props } = page(async () => { if (failing) throw new Error('host'); return { kind: 'ok', seen: SEEN }; });
    const tab = await screen.findByRole('tab', { name: 'Reports, 2 unread' });
    failing = true;
    fireEvent.click(tab);
    expect(await screen.findByText('Title 2026-10-13')).toBeTruthy();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(props.store.setReportsSeen).not.toHaveBeenCalled();
  });

  it('opening a sub-tab marks every edition seen, collapsed ones included', async () => {
    const { props } = page(async () => ({ kind: 'ok', seen: { ...SEEN, daily: '2026-10-11T12:00:00.000Z' } }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Reports, 3 unread' }));
    expect(await screen.findByText('Title 2026-10-12')).toBeTruthy();
    expect(document.querySelectorAll('details[open]').length).toBe(0);
    await waitFor(() => expect(props.store.setReportsSeen).toHaveBeenCalledWith(NEWEST));
    expect(await screen.findByRole('tab', { name: 'Reports' })).toBeTruthy();
  });

  it('a new edition arriving while the page is open shows a badge after the live refresh', async () => {
    const reports: Record<ReportKind, ReportStore> = { ...REPORTS, weekly: { live: null, archive: [] } };
    const { props } = page(async () => ({ kind: 'ok', seen: { daily: NEWEST.daily, monthly: NEWEST.monthly } }), async () => {}, reports);
    // The first read has landed: all three archives were fetched.
    await waitFor(() => expect(props.store.getReports).toHaveBeenCalledTimes(3));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole('tab', { name: 'Reports' })).toBeTruthy();
    reports.weekly = REPORTS.weekly;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(await screen.findByRole('tab', { name: 'Reports, 1 unread' })).toBeTruthy();
  });

  it('an older store with no getReportsSeen shows no badge and never writes', async () => {
    const props = makeProps();
    props.store.getUiState = vi.fn(async () => ({ activeTab: 'home' }));
    props.store.getReports = vi.fn(async (kind: ReportKind) => REPORTS[kind]);
    props.store.setReportsSeen = vi.fn(async () => {});
    delete (props.store as any).getReportsSeen;
    expect((props.store as any).getReportsSeen).toBeUndefined();
    render(<SyncPage {...props} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Reports' }));
    expect(await screen.findByText('Title 2026-10-13')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /unread/ })).toBeNull();
    expect(document.querySelector('.sfin-inbox-new')).toBeNull();
    expect(props.store.setReportsSeen).not.toHaveBeenCalled();
  });
});
