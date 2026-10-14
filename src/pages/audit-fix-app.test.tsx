import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { SyncPage } from './SyncPage';
import { makeProps } from './test-props';
import { AUDIT_AFTER_SYNC } from '../components/AuditViews';
import { healthIssues } from '../../shared/audit-health';
import type { AuditLedgerRow } from '../../shared/audit-ledger';
import { buildAuditSnapshot, parseAuditSnapshot } from '../../shared/audit-snapshot';
import { emptySyncOverrides } from '../../shared/sync-overrides';

/**
 * Link through the page (2c R2, spec C1): Settings → Checks links a pair with
 * the add-on's own host, then reads the snapshot again.
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

const AT = new Date(2026, 9, 14, 10, 0);
const LATER = new Date(2026, 9, 14, 12, 0);
const row = (over: Partial<AuditLedgerRow>): AuditLedgerRow => ({
  id: 'r', accountId: 'wf-b', date: '2026-10-04', currency: 'USD', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', status: 'POSTED',
  absCents: 60000, group: '', assetId: '', external: false, phantomCash: false, notes: 'TO SAVINGS · TRN-6', ...over,
});
/** test-props' Spend (sfin-2 → wf-b) sent $600 to Growth (sfin-1 → wf-a), and neither side is linked. */
const ledger = {
  accounts: [{ id: 'wf-a', name: 'Growth', type: 'CASH', archived: false }, { id: 'wf-b', name: 'Spend', type: 'CASH', archived: false }],
  rows: [row({ id: 'out' }), row({ id: 'in', accountId: 'wf-a', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-10-05', notes: 'FROM SPEND · TRN-7' })],
};
const read = () => parseAuditSnapshot(JSON.stringify(buildAuditSnapshot({
  balances: { accounts: [], notes: [] },
  headline: { month: '2026-10', reportCents: null, wealthfolioCents: null, unexplainedCents: null, reasons: null, notes: [] },
  health: healthIssues({ ledger, mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' } }),
}, AT)));
const stored = () => [
  { id: 'out', accountId: 'wf-b', accountName: 'Spend', activityType: 'TRANSFER_OUT', date: '2026-10-04T00:00:00.000Z', amount: '600', currency: 'USD', comment: 'TO SAVINGS · TRN-6', metadata: null },
  { id: 'in', accountId: 'wf-a', accountName: 'Growth', activityType: 'DEPOSIT', date: '2026-10-05T00:00:00.000Z', amount: '600', currency: 'USD', comment: 'FROM SPEND · TRN-7', metadata: null },
];

describe('Settings → Checks → Link', () => {
  it('links the pair through the add-on, says so, and reads the snapshot again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LATER);
    onTestFinished(() => { vi.useRealTimers(); });
    const props = makeProps();
    const rows = stored();
    props.ctx.api.accounts.getAll = vi.fn(async () => [{ id: 'wf-a', name: 'Growth', accountType: 'CASH' }, { id: 'wf-b', name: 'Spend', accountType: 'CASH' }]);
    props.ctx.api.activities = {
      search: vi.fn(async (_p: number, _s: number, f: { activityIds?: string[] }) => ({ data: rows.filter((r) => f.activityIds?.includes(r.id)), meta: { totalRowCount: 0 } })),
      saveMany: vi.fn(async (req: { creates?: Array<Record<string, unknown>> }) => ({
        created: (req.creates ?? []).map((w, i) => ({ id: `new-${i}`, accountId: w.accountId, notes: w.comment, sourceGroupId: w.sourceGroupId })),
        updated: [], errors: [],
      })),
    };
    props.store.getUiState = vi.fn(async () => ({ activeTab: 'settings' }));
    props.store.getOpenCards = vi.fn(async () => ({ checks: true }));
    props.store.getCompanionVersion = vi.fn(async () => '1.61.0');
    props.store.getAuditSnapshot = vi.fn(async () => read());
    props.store.readSyncOverrides = vi.fn(async () => ({ overrides: emptySyncOverrides(), unreadable: false }));
    props.store.getLinkedGroups = vi.fn(async () => ({}));
    props.store.setLinkedGroups = vi.fn(async () => {});
    props.store.recordChange = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    const link = await screen.findByRole('button', { name: 'Link' });
    const reads = props.store.getAuditSnapshot.mock.calls.length;
    fireEvent.click(link);
    expect(await screen.findByText(`Linked. ${AUDIT_AFTER_SYNC}`)).toBeInTheDocument();
    expect(props.ctx.api.activities.saveMany).toHaveBeenCalledWith({ deleteIds: ['out', 'in'] });
    expect(props.store.recordChange).toHaveBeenCalledWith(expect.objectContaining({ actor: 'you', kind: 'transfer-link' }));
    await waitFor(() => expect(props.store.getAuditSnapshot).toHaveBeenCalledTimes(reads + 1));
  });
});
