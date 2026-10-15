import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { SyncPage } from './SyncPage';
import { makeProps } from './test-props';
import { BudgetTab } from '../tabs/BudgetTab';
import type { ReportCube } from '../../shared/report-cube';
import { AUDIT_HEADLINE_LINK } from '../components/AuditViews';
import { explainBalances } from '../../shared/audit-balance';
import { explainHeadline } from '../../shared/audit-headline';
import { healthIssues } from '../../shared/audit-health';
import type { AuditLedgerRow } from '../../shared/audit-ledger';
import {
  buildAuditSnapshot, parseAuditSnapshot, AUDIT_CORRUPT, AUDIT_NEEDS_COMPANION, AUDIT_NOT_YET, type AuditSnapshotRead,
} from '../../shared/audit-snapshot';

/**
 * The app's three ways into the audits (2c R1, spec A5), through the page
 * that loads the snapshot: Settings → Checks and the Accounts card's chips,
 * Home's Accounts tile, and the Budget tab's link.
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

const AT = new Date(2026, 9, 13, 14, 0);
const LATER = new Date(2026, 9, 13, 18, 30);
const ISSUE = 'TO SAVINGS · $600.00 · Spend · Oct 4';

const row = (over: Partial<AuditLedgerRow>): AuditLedgerRow => ({
  id: 'r', accountId: 'wf-b', date: '2026-10-04', currency: 'USD', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL', status: 'POSTED',
  absCents: 0, group: '', assetId: '', external: false, phantomCash: false, notes: 'ROW · TRN-0', ...over,
});
/** test-props' Spend (sfin-2 → wf-b) is off by $15.22: a pending charge, and one unlinked transfer.
 *  The report counts $1,300.00 this month and Wealthfolio $1,200.00, unless `headline` says otherwise. */
function snapshot(headline = explainHeadline({ month: '2026-10', reportCents: 130000, wealthfolioCents: 120000, rows: [], excludedCategoryIds: [] })): AuditSnapshotRead {
  const ledger = {
    accounts: [{ id: 'wf-b', name: 'Spend', type: 'CASH', archived: false }],
    rows: [
      row({ id: 'p', absCents: 1522, notes: 'COFFEE · TRN-5 · pending' }),
      row({ id: 'out', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', absCents: 60000, notes: 'TO SAVINGS · TRN-6' }),
    ],
  };
  return parseAuditSnapshot(JSON.stringify(buildAuditSnapshot({
    balances: explainBalances({
      mapping: { 'sfin-2': 'wf-b' }, balances: { 'sfin-2': { balance: -420.1, date: null } }, names: { 'sfin-2': 'Spend' },
      valuations: { 'wf-b': -43532 }, ledger,
    }),
    headline,
    health: healthIssues({ ledger, mapping: { 'sfin-2': 'wf-b' } }),
  }, AT)));
}

const at = (when: Date) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(when);
  onTestFinished(() => { vi.useRealTimers(); });
};

function page(read: AuditSnapshotRead, opts: { tab?: string; cards?: Record<string, boolean>; companion?: string | null } = {}) {
  const props = makeProps();
  props.store.getUiState = vi.fn(async () => ({ activeTab: opts.tab ?? 'settings' }));
  props.store.getOpenCards = vi.fn(async () => opts.cards ?? {});
  props.store.getCompanionVersion = vi.fn(async () => (opts.companion === undefined ? '1.61.0' : opts.companion));
  props.store.getAuditSnapshot = vi.fn(async () => read);
  return { props, ...render(<SyncPage {...props} />) };
}

describe('Settings → Checks', () => {
  it('lists what Health flags, with when the checks were taken', async () => {
    at(LATER);
    page(snapshot(), { cards: { checks: true } });
    expect(await screen.findByText('1 to look at')).toBeInTheDocument();
    expect(screen.getByText(ISSUE)).toBeInTheDocument();
    expect(screen.getByText('No likely other half within 5 days — if it has one, link the two in Wealthfolio.')).toBeInTheDocument();
    expect(screen.getByText('As of the 2:00 PM sync.')).toBeInTheDocument();
  });

  it.each<[string, () => AuditSnapshotRead, string | null, Date, string, string]>([
    ['stale', snapshot, '1.61.0', new Date(2026, 9, 16, 9, 0), '1 to look at', "These checks are from Oct 13 — the companion hasn't synced since."],
    ['corrupt', () => ({ kind: 'corrupt' }), '1.61.0', LATER, "Couldn't read", AUDIT_CORRUPT],
    ['missing, with the companion', () => ({ kind: 'absent' }), '1.61.0', LATER, 'Arrive with the next sync', AUDIT_NOT_YET],
  ])('says so when the snapshot is %s', async (_what, read, companion, now, summary, line) => {
    at(now);
    page(read(), { cards: { checks: true }, companion });
    expect(await screen.findByText(summary)).toBeInTheDocument();
    expect(screen.getByText(line)).toBeInTheDocument();
  });

  it('is not there at all for an add-on-only install: no snapshot and no companion', async () => {
    at(LATER);
    const { props } = page({ kind: 'absent' }, { cards: { checks: true, accounts: true }, companion: null });
    await waitFor(() => expect(props.store.getCompanionVersion).toHaveBeenCalled());
    await waitFor(() => expect(document.querySelector('#sfin-panel-settings')).toBeTruthy());
    expect((await screen.findAllByText('Accounts')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Checks')).toBeNull();
    expect(screen.queryByText('Need the companion')).toBeNull();
    expect(screen.queryByText(AUDIT_NEEDS_COMPANION)).toBeNull();
  });

  it('an account’s "off by" chip opens why in place, under the account', async () => {
    at(LATER);
    const { container } = page(snapshot(), { cards: { accounts: true } });
    await waitFor(() => expect(container.querySelector('button.sfin-audit-chip')).toBeTruthy());
    fireEvent.click(container.querySelector('button.sfin-audit-chip')!);
    expect(screen.getByText('Bank: -$420.10 · Wealthfolio: -$435.32 · Off by $15.22')).toBeInTheDocument();
    expect(screen.getByText("$15.22 in 1 pending transaction the bank hasn't posted")).toBeInTheDocument();
  });
});

describe('Home’s Accounts tile', () => {
  it('says how many checks to look at, and opens Settings on the Checks card', async () => {
    at(LATER);
    page(snapshot(), { tab: 'home' });
    const tile = await screen.findByRole('button', { name: /^Accounts: .* · Checks: 1 to look at$/ });
    expect(screen.getByText('Checks: 1 to look at')).toBeInTheDocument();
    fireEvent.click(tile);
    expect(await screen.findByText(ISSUE)).toBeInTheDocument();
  });

  it('shows when the last sync found the report and Wealthfolio apart this month', async () => {
    at(LATER);
    page(snapshot(), { tab: 'home' });
    expect(await screen.findByText('The report and Wealthfolio differ by $100.00 this month')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Accounts: .* · The report and Wealthfolio differ by \$100\.00 this month · Checks: 1 to look at$/ })).toBeInTheDocument();
  });

  it.each([
    ['a cent apart', explainHeadline({ month: '2026-10', reportCents: 120001, wealthfolioCents: 120000, rows: [], excludedCategoryIds: [] })],
    ['Wealthfolio’s figure unread', explainHeadline({ month: '2026-10', reportCents: 130000, rows: [], failed: ['wealthfolio'] })],
    ['last month’s checks', explainHeadline({ month: '2026-09', reportCents: 130000, wealthfolioCents: 120000, rows: [] })],
    // LU-J: the whole gap is an account the add-on does not sync (the explained not-covered reason).
    ['the gap being only an account the add-on does not sync', explainHeadline({
      month: '2026-10', timezone: 'UTC', reportCents: 0, wealthfolioCents: 2000, excludedCategoryIds: [],
      spendingAccountIds: ['wf-b', 'wf-jar'], reportAccountIds: ['wf-b'],
      rows: [{
        id: 'jar-1', date: '2026-10-05T12:00:00+00:00', accountId: 'wf-jar', groupId: '', accountName: 'Jar', accountType: 'CASH',
        type: 'WITHDRAWAL', subtype: '', absCents: 2000, notes: 'COFFEE · TRN-9', filings: [], splits: [],
      }],
    })],
  ])('says nothing about the two when %s', async (_what, headline) => {
    at(LATER);
    page(snapshot(headline), { tab: 'home' });
    await screen.findByRole('button', { name: /^Accounts: .* · Checks: 1 to look at$/ });
    expect(screen.queryByText(/differ by/)).toBeNull();
  });

  it('says nothing about checks with nothing to look at, and still opens Accounts', async () => {
    at(LATER);
    page({ kind: 'absent' }, { tab: 'home' });
    const tile = await screen.findByRole('button', { name: /^Accounts: / });
    expect(screen.queryByText(/Checks:/)).toBeNull();
    fireEvent.click(tile);
    await waitFor(() => expect(document.querySelector('#sfin-panel-settings')).toBeTruthy());
    expect(screen.queryByText(ISSUE)).toBeNull();
  });
});

describe('the Budget tab', () => {
  const CUBE: ReportCube = {
    version: 1, asOf: LATER.toISOString(), months: ['2026-10'], categories: ['Food'],
    accounts: [{ sfinId: 'sfin-2', name: 'Spend', type: 'CASH' }],
    spend: [[[100000]]], uncategorized: [[30000]], income: [[0]], budgets: [[0]], merchants: [[]], feesInterest: [0],
    netWorth: [null], liquid: [null], pool: null,
  };
  const tab = (audit?: React.ComponentProps<typeof BudgetTab>['audit']) => render(
    <BudgetTab cube={CUBE} customReports={[]} layout={null} onLayoutChange={() => {}} onCustomReportsChange={() => {}} store={{} as any} audit={audit} />,
  );

  it('opens "Why is this different from Wealthfolio?" in place', () => {
    tab({ read: snapshot(), companionVersion: '1.61.0', now: LATER });
    fireEvent.click(screen.getByRole('button', { name: AUDIT_HEADLINE_LINK }));
    expect(screen.getByText("The report counts $1,300.00 spent this month; Wealthfolio's Spending page counts $1,200.00.")).toBeInTheDocument();
    expect(screen.getByText('$100.00 not explained by these reasons')).toBeInTheDocument();
  });

  it('shows no link without the snapshot', () => {
    tab();
    expect(screen.queryByRole('button', { name: AUDIT_HEADLINE_LINK })).toBeNull();
  });
});
