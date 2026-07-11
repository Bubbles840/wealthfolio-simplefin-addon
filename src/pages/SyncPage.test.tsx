import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SyncPage } from './SyncPage';

vi.mock('../utils/sync', () => ({
  runSync: vi.fn(async () => ({ imported: 5, skipped: 1, errors: [] })),
}));

const makeProps = () => ({
  ctx: {
    api: { accounts: { getAll: vi.fn(async () => [{ id: 'wf-a', name: 'Checking' }]) } },
  } as any,
  store: {
    getLastSyncAt: vi.fn(async () => new Date('2024-01-01T10:00:00Z')),
    getAccountMapping: vi.fn(async () => ({ 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' })),
    getMappingRules: vi.fn(async () => []),
    getSyncScheduleHours: vi.fn(async () => 6),
    getAccessUrl: vi.fn(async () => 'https://u:p@bridge.simplefin.org/simplefin'),
    getAccountNames: vi.fn(async () => ({ 'sfin-1': 'Growth', 'sfin-2': 'Spend' })),
    setAccountNames: vi.fn(),
    getAuthB64Key: vi.fn(async () => 'simplefin_auth_b64'),
    setLastSyncAt: vi.fn(),
  } as any,
  onReset: vi.fn(),
  scheduler: { start: vi.fn(), stop: vi.fn(), isRunning: vi.fn(() => false) } as any,
});

describe('SyncPage', () => {
  it('renders Sync Now button', async () => {
    render(<SyncPage {...makeProps()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /sync now/i })).toBeInTheDocument());
  });

  it('shows sync result after clicking Sync Now', async () => {
    render(<SyncPage {...makeProps()} />);
    await waitFor(() => screen.getByRole('button', { name: /sync now/i }));
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(() => expect(screen.getByText(/5 transactions/i)).toBeInTheDocument());
  });

  it('shows account names instead of raw IDs in the mapping list', async () => {
    render(<SyncPage {...makeProps()} />);
    await waitFor(() => expect(screen.getByText(/Growth/)).toBeInTheDocument());
    expect(screen.getByText(/Checking/)).toBeInTheDocument();
    // Raw IDs may appear in the Docker guide's generated config, but the
    // mapping list itself must show names
    const growthItem = screen.getByText(/Growth/).closest('li');
    expect(growthItem?.textContent).not.toContain('sfin-1');
  });
});
