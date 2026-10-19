import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { SyncPage } from './SyncPage';
import { makeProps } from './test-props';
import { buildAuditSnapshot, parseAuditSnapshot } from '../../shared/audit-snapshot';
import type { HeldTransfer } from '../../shared/held-transfers';
import { emptySyncOverrides, SYNC_OVERRIDES_UNREADABLE_MESSAGE, SyncOverridesUnreadableError, type SyncOverridesEdit } from '../../shared/sync-overrides';
import { accountTxKey } from '../../shared/transfers';
import { NOT_TRANSFER_FAILED, NOT_TRANSFER_STALE } from '../utils/audit-fix';
import { beginWrite, writeRefusal } from '../utils/write-lock';
import { checksSummary, HeldTransfersView } from '../components/AuditViews';

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

/** The placeholder as Wealthfolio stores it right now. */
const liveRow = (over: Record<string, unknown> = {}) => ({
  id: 'ph-1', accountId: 'wf-b', accountName: 'Spend', activityType: 'TRANSFER_OUT', date: '2026-09-29T00:00:00.000Z', amount: '250', currency: 'USD',
  comment: '↔️ In-transit transfer · WIRE TRANSFER TO ACME LLC · w-old', metadata: null, ...over,
});

function settingsWith(held: HeldTransfer[], rows: Array<Record<string, unknown>> = [liveRow()]) {
  const props = makeProps();
  props.ctx.api.accounts.getAll = vi.fn(async () => [{ id: 'wf-b', name: 'Spend', accountType: 'CASH' }]);
  props.ctx.api.activities = {
    search: vi.fn(async (_p: number, _s: number, f: { activityIds?: string[] }) => ({ data: rows.filter((r) => f.activityIds?.includes(String(r.id))), meta: { totalRowCount: 0 } })),
  } as never;
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

  it('refuses, writing nothing, when the pair was linked since the checks ran', async () => {
    const props = settingsWith([HELD], [liveRow({ sourceGroupId: 'wf-transfer-9' })]);
    props.store.editSyncOverrides = vi.fn();
    render(<SyncPage {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not a transfer' }));
    expect(await screen.findByText(NOT_TRANSFER_STALE)).toBeInTheDocument();
    expect(props.store.editSyncOverrides).not.toHaveBeenCalled();
  });

  it('refuses, writing nothing, when the add-on\'s own ledger of pairs knows the leg', async () => {
    const props = settingsWith([HELD]);
    props.store.getLinkedGroups = vi.fn(async () => ({ [HELD.txKey!]: 'wf-transfer-9' }));
    props.store.editSyncOverrides = vi.fn();
    render(<SyncPage {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not a transfer' }));
    expect(await screen.findByText(NOT_TRANSFER_STALE)).toBeInTheDocument();
    expect(props.store.editSyncOverrides).not.toHaveBeenCalled();
  });

  it.each<[string, Array<Record<string, unknown>>]>([
    ['the row is gone', []],
    ['it already settled (no in-transit note)', [liveRow({ comment: 'WIRE TRANSFER TO ACME LLC · w-old' })]],
    ['it went pending', [liveRow({ comment: '↔️ In-transit transfer · WIRE TRANSFER TO ACME LLC · w-old · pending' })]],
    ['it is now a different bank transaction', [liveRow({ comment: '↔️ In-transit transfer · WIRE TRANSFER TO ACME LLC · w-other' })]],
  ])('refuses, writing nothing, when %s', async (_why, rows) => {
    const props = settingsWith([HELD], rows);
    props.store.editSyncOverrides = vi.fn();
    render(<SyncPage {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not a transfer' }));
    expect(await screen.findByText(NOT_TRANSFER_STALE)).toBeInTheDocument();
    expect(props.store.editSyncOverrides).not.toHaveBeenCalled();
  });

  it('writes nothing, and says so, when the row cannot be re-read', async () => {
    const props = settingsWith([HELD]);
    props.ctx.api.activities.search = vi.fn(async () => { throw new Error('offline'); });
    props.store.editSyncOverrides = vi.fn();
    render(<SyncPage {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not a transfer' }));
    expect(await screen.findByText(NOT_TRANSFER_FAILED)).toBeInTheDocument();
    expect(props.store.editSyncOverrides).not.toHaveBeenCalled();
  });

  it('shows the row as marked, with no button, when the page is opened again after a tap', async () => {
    const props = settingsWith([HELD]);
    let written = emptySyncOverrides();
    props.store.editSyncOverrides = vi.fn(async (edit: SyncOverridesEdit) => (written = edit(written)));
    props.store.readSyncOverrides = vi.fn(async () => ({ overrides: written, unreadable: false }));
    const { unmount } = render(<SyncPage {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not a transfer' }));
    await screen.findByText('Saved — the next sync counts it as spending.');
    unmount();
    render(<SyncPage {...props} />);
    expect(await screen.findByText(/marked not a transfer; the next sync settles it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not a transfer' })).toBeNull();
  });

  it('keeps the button when the overrides cannot be read on opening', async () => {
    const props = settingsWith([HELD]);
    props.store.editSyncOverrides = vi.fn();
    props.store.readSyncOverrides = vi.fn(async () => ({ overrides: emptySyncOverrides(), unreadable: true }));
    render(<SyncPage {...props} />);
    expect(await screen.findByRole('button', { name: 'Not a transfer' })).toBeInTheDocument();
  });

  it('renders no section for an empty or missing list', async () => {
    const empty = settingsWith([]);
    const { unmount } = render(<SyncPage {...empty} />);
    expect(await screen.findByText('Checks')).toBeInTheDocument();
    expect(screen.queryByText('Still in transit')).toBeNull();
    unmount();
    const missing = settingsWith([]);
    missing.store.getAuditSnapshot = vi.fn(async () => parseAuditSnapshot(JSON.stringify((() => {
      const { held: _h, ...rest } = (read([]) as unknown as { kind: 'ok'; snapshot: Record<string, unknown> }).snapshot;
      return rest;
    })())));
    render(<SyncPage {...missing} />);
    expect(await screen.findByText('Checks')).toBeInTheDocument();
    expect(screen.queryByText('Still in transit')).toBeNull();
  });
});

describe('HeldTransfersView buttons', () => {
  const two: HeldTransfer[] = [HELD, { ...HELD, activityId: 'ph-2', txKey: accountTxKey('sfin-2', 'w-2') }];

  it('re-enables the buttons when the action rejects', async () => {
    const notTransfer = vi.fn(async () => { throw new Error('boom'); });
    render(<HeldTransfersView held={two} notTransfer={notTransfer} />);
    const [first] = screen.getAllByRole('button', { name: 'Not a transfer' });
    fireEvent.click(first);
    await waitFor(() => expect(notTransfer).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Not a transfer' })[0]).not.toBeDisabled());
  });

  it('runs once on a double click, and keys done on ok, not on wording', async () => {
    let release!: (v: { ok: boolean; message: string }) => void;
    const notTransfer = vi.fn(() => new Promise<{ ok: boolean; message: string }>((r) => { release = r; }));
    render(<HeldTransfersView held={two} notTransfer={notTransfer} />);
    const [first] = screen.getAllByRole('button', { name: 'Not a transfer' });
    fireEvent.click(first);
    fireEvent.click(first);
    expect(notTransfer).toHaveBeenCalledTimes(1);
    release({ ok: true, message: 'Done and dusted.' });
    expect(await screen.findByText('Done and dusted.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Not a transfer' })).toHaveLength(1);
  });

  it('keeps the button after a refusal that starts with the word Saved', async () => {
    const notTransfer = vi.fn(async () => ({ ok: false, message: 'Saved nothing.' }));
    render(<HeldTransfersView held={[HELD]} notTransfer={notTransfer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Not a transfer' }));
    expect(await screen.findByText('Saved nothing.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not a transfer' })).toBeInTheDocument();
  });
});

describe('the collapsed Checks summary counts held transfers', () => {
  it('says to look at them instead of "Nothing found"', () => {
    expect(checksSummary(read([HELD, { ...HELD, activityId: 'ph-2', marked: true }]), '1.65.0')).toBe('1 to look at');
    expect(checksSummary(read([{ ...HELD, marked: true }]), '1.65.0')).toBe('Nothing found');
    expect(checksSummary(read([]), '1.65.0')).toBe('Nothing found');
  });
});

describe('Not a transfer: the write lock and Wealthfolio\'s own link fact', () => {
  /** Wealthfolio 3.9+: the cash search reports the row's link status. */
  const withFact = (props: ReturnType<typeof settingsWith>, status: { transferLinkStatus: string; sourceGroupId: string | null }) => {
    props.ctx.api.spending = {
      searchCashActivities: vi.fn(async (req: { accountIds?: string[] }) => {
        const items = (req.accountIds ?? []).includes('wf-b') ? [{ ...liveRow(), activityDate: '2026-09-29', cashFlowBucket: 'neutral', assignments: [], splits: [], ...status }] : [];
        return { items, totalCount: items.length };
      }),
    } as never;
  };

  it('refuses while another write holds the lock, and writes nothing', async () => {
    const props = settingsWith([HELD]);
    props.store.editSyncOverrides = vi.fn();
    render(<SyncPage {...props} />);
    const button = await screen.findByRole('button', { name: 'Not a transfer' });
    const release = beginWrite()!;
    onTestFinished(() => { release(); });
    fireEvent.click(button);
    expect(await screen.findByText(writeRefusal('remove'))).toBeInTheDocument();
    expect(props.store.editSyncOverrides).not.toHaveBeenCalled();
    expect(props.ctx.api.activities.search).not.toHaveBeenCalled();
  });

  it('refuses when Wealthfolio says the row is linked', async () => {
    const props = settingsWith([HELD]);
    withFact(props, { transferLinkStatus: 'linked', sourceGroupId: 'grp-9' });
    props.store.editSyncOverrides = vi.fn();
    render(<SyncPage {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not a transfer' }));
    expect(await screen.findByText(NOT_TRANSFER_STALE)).toBeInTheDocument();
    expect(props.store.editSyncOverrides).not.toHaveBeenCalled();
  });

  it('goes ahead when Wealthfolio says unlinked, over a stale entry in the add-on\'s ledger of pairs', async () => {
    const props = settingsWith([HELD]);
    withFact(props, { transferLinkStatus: 'unlinked', sourceGroupId: null });
    props.store.getLinkedGroups = vi.fn(async () => ({ [HELD.txKey!]: 'wf-transfer-old' }));
    let written = emptySyncOverrides();
    props.store.editSyncOverrides = vi.fn(async (edit: SyncOverridesEdit) => (written = edit(written)));
    render(<SyncPage {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not a transfer' }));
    expect(await screen.findByText('Saved — the next sync counts it as spending.')).toBeInTheDocument();
    expect(written.tx[HELD.txKey!]).toMatchObject({ notTransfer: true });
  });
});
