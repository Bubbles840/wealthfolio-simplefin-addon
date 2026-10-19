import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SyncPage } from './SyncPage';
import { makeProps } from './test-props';
import { buildAuditSnapshot, parseAuditSnapshot } from '../../shared/audit-snapshot';
import type { HeldTransfer } from '../../shared/held-transfers';
import { emptySyncOverrides, SYNC_OVERRIDES_UNREADABLE_MESSAGE, SyncOverridesUnreadableError, type SyncOverridesEdit } from '../../shared/sync-overrides';
import { accountTxKey } from '../../shared/transfers';
import { NOT_TRANSFER_FAILED } from '../utils/audit-fix';

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

const AT = new Date(2026, 9, 19, 10, 0);
const HELD: HeldTransfer = {
  activityId: 'ph-1', description: 'WIRE TRANSFER TO ACME LLC', amount: 250, ageDays: 20, direction: 'out',
  heldBy: 'Harbor Savings', txKey: accountTxKey('sfin-2', 'w-old'), label: 'WIRE TRANSFER TO ACME LLC · Spend',
};
const read = (held: HeldTransfer[]) => parseAuditSnapshot(JSON.stringify(buildAuditSnapshot({
  balances: { accounts: [], notes: [] },
  headline: { month: '2026-10', reportCents: null, wealthfolioCents: null, unexplainedCents: null, reasons: null, notes: [] },
  health: { issues: [], notes: [] },
  held,
}, AT)));

function settingsWith(held: HeldTransfer[]) {
  const props = makeProps();
  props.store.getUiState = vi.fn(async () => ({ activeTab: 'settings' }));
  props.store.getOpenCards = vi.fn(async () => ({ checks: true }));
  props.store.getCompanionVersion = vi.fn(async () => '1.65.0');
  props.store.getAuditSnapshot = vi.fn(async () => read(held));
  return props;
}

describe('Settings → Checks → Not a transfer (1.65 C)', () => {
  it('lists a transfer still in transit with why, and "Not a transfer" records notTransfer for it', async () => {
    const props = settingsWith([HELD]);
    let written = emptySyncOverrides();
    props.store.editSyncOverrides = vi.fn(async (edit: SyncOverridesEdit) => (written = edit(written)));
    render(<SyncPage {...props} />);
    expect(await screen.findByText('Still in transit')).toBeInTheDocument();
    expect(screen.getByText("WIRE TRANSFER TO ACME LLC ($250.00) has waited 20 days for its other half — Harbor Savings's feed is behind, so it stays on hold")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not a transfer' }));
    expect(await screen.findByText('Saved — the next sync counts it as spending.')).toBeInTheDocument();
    expect(written.tx[HELD.txKey!]).toMatchObject({ notTransfer: true, label: 'WIRE TRANSFER TO ACME LLC · Spend' });
    expect(screen.queryByRole('button', { name: 'Not a transfer' })).toBeNull();
  });

  it('says so when the overrides cannot be read, and writes nothing', async () => {
    const props = settingsWith([HELD]);
    props.store.editSyncOverrides = vi.fn(async () => { throw new SyncOverridesUnreadableError(); });
    render(<SyncPage {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not a transfer' }));
    expect(await screen.findByText(SYNC_OVERRIDES_UNREADABLE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not a transfer' })).toBeInTheDocument();
  });

  it('says nothing was changed on any other failure, and keeps the button', async () => {
    const props = settingsWith([HELD]);
    props.store.editSyncOverrides = vi.fn(async () => { throw new Error('network down'); });
    render(<SyncPage {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not a transfer' }));
    expect(await screen.findByText(NOT_TRANSFER_FAILED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not a transfer' })).toBeInTheDocument();
  });

  it('shows a marked row with its message and no button', async () => {
    const props = settingsWith([{ ...HELD, marked: true }]);
    props.store.editSyncOverrides = vi.fn();
    render(<SyncPage {...props} />);
    expect(await screen.findByText('WIRE TRANSFER TO ACME LLC ($250.00) has waited 20 days for its other half — marked not a transfer; the next sync settles it')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not a transfer' })).toBeNull();
  });

  it('offers no button for a row with no bank transaction to name (ambiguous own feed), or on a store that cannot write overrides', async () => {
    const props = settingsWith([{ ...HELD, txKey: null }]);
    props.store.editSyncOverrides = vi.fn();
    const { unmount } = render(<SyncPage {...props} />);
    expect(await screen.findByText('Still in transit')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not a transfer' })).toBeNull();
    unmount();
    const older = settingsWith([HELD]);
    delete (older.store as { editSyncOverrides?: unknown }).editSyncOverrides;
    render(<SyncPage {...older} />);
    expect(await screen.findByText('Still in transit')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not a transfer' })).toBeNull();
  });
});
