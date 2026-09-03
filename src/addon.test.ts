/**
 * Tests for src/addon.tsx
 *
 * Strategy:
 *  - Wiring tests verify enable() registers the right route id/component and onDisable.
 *  - Behaviour tests use React Testing Library to render SimplefinSyncView directly,
 *    avoiding module-level singleton state by passing deps as props.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('./pages/SetupPage', () => ({ SetupPage: vi.fn(() => React.createElement('div', null, 'SetupPage')) }));
vi.mock('./pages/SyncPage', () => ({ SyncPage: vi.fn(() => React.createElement('div', null, 'SyncPage')) }));
vi.mock('./utils/sync', () => ({
  runSync: vi.fn(async () => ({ imported: 0, skipped: 0, errors: [] })),
  MIN_SYNC_INTERVAL_MS: 3_600_000,
}));

import enable, { SimplefinSyncView } from './addon';
import { SIMPLEFIN_SYNC_VERSION } from '../shared/version';
import { runSync } from './utils/sync';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx() {
  let disableCallback: (() => void) | null = null;
  const ctx = {
    sidebar: { addItem: vi.fn(() => ({ remove: vi.fn() })) },
    router: { add: vi.fn() },
    onDisable: vi.fn((cb: () => void) => { disableCallback = cb; }),
    api: {
      secrets: { get: vi.fn(async () => null), set: vi.fn(), delete: vi.fn() },
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    },
    _triggerDisable: () => disableCallback?.(),
  } as any;
  return ctx;
}

type StoreOverrides = {
  accessUrl?: string | null;
  accountMapping?: Record<string, string> | null;
  syncScheduleHours?: number | null;
};

function makeStore(overrides: StoreOverrides = {}) {
  const { accessUrl = null, accountMapping = null, syncScheduleHours = null } = overrides;
  return {
    getAccessUrl: vi.fn(async () => accessUrl),
    getAccountMapping: vi.fn(async () => accountMapping),
    getSyncScheduleHours: vi.fn(async () => syncScheduleHours),
    getMappingRules: vi.fn(async () => []),
    getLastSyncAt: vi.fn(async () => null),
    setAccessUrl: vi.fn(),
    setAccountMapping: vi.fn(),
    setMappingRules: vi.fn(),
    setSyncScheduleHours: vi.fn(),
    setLastSyncAt: vi.fn(),
    clearAll: vi.fn(),
  } as any;
}

function makeScheduler(running = false) {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn(() => running),
  } as any;
}

// ── enable() wiring tests ─────────────────────────────────────────────────────

describe('addon enable()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers a route at /addons/simplefin-sync with a render function', () => {
    const ctx = makeCtx();
    enable(ctx);
    expect(ctx.router.add).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/addons/simplefin-sync', render: expect.any(Function) }),
    );
  });

  it('calls ctx.sidebar.addItem with the correct sidebar entry', () => {
    const ctx = makeCtx();
    enable(ctx);
    expect(ctx.sidebar.addItem).toHaveBeenCalledWith({
      id: 'simplefin-sync',
      label: 'SimpleFin Sync',
      icon: 'bank',
      route: '/addons/simplefin-sync',
      order: 90,
    });
  });

  it('runs a catch-up sync on startup when auto-sync is enabled', async () => {
    vi.mocked(runSync).mockClear();
    const ctx = makeCtx();
    const values: Record<string, string> = {
      simplefin_access_url: 'https://u:p@bridge.simplefin.org/simplefin',
      account_mapping: JSON.stringify({ 'sfin-1': 'wf-a' }),
      sync_schedule_hours: '6',
    };
    ctx.api.secrets.get = vi.fn(async (k: string) => values[k] ?? null);
    enable(ctx);
    // The scheduler's immediate wall-clock check sees no prior sync (due) and
    // triggers runSync — this is the startup catch-up.
    await waitFor(() => expect(runSync).toHaveBeenCalled());
  });

  it('does not sync on startup when auto-sync is off', async () => {
    vi.mocked(runSync).mockClear();
    const ctx = makeCtx();
    const values: Record<string, string> = {
      simplefin_access_url: 'https://u:p@bridge.simplefin.org/simplefin',
      account_mapping: JSON.stringify({ 'sfin-1': 'wf-a' }),
      sync_schedule_hours: '0',
    };
    ctx.api.secrets.get = vi.fn(async (k: string) => values[k] ?? null);
    enable(ctx);
    await new Promise((r) => setTimeout(r, 20));
    expect(runSync).not.toHaveBeenCalled();
  });

  it('does not sync on startup when not configured', async () => {
    vi.mocked(runSync).mockClear();
    const ctx = makeCtx(); // secrets.get returns null
    enable(ctx);
    await new Promise((r) => setTimeout(r, 20));
    expect(runSync).not.toHaveBeenCalled();
  });

  it('publishes the addon version on startup so the companion can flag a half-finished update', async () => {
    // The companion's self-check compares this against its own build; without
    // the write, skew is visible only on a Sync-page footer nobody re-reads.
    const ctx = makeCtx();
    enable(ctx);
    await waitFor(() => expect(ctx.api.secrets.set).toHaveBeenCalledWith('addon_version', SIMPLEFIN_SYNC_VERSION));
  });

  it('does not rewrite the version secret when it is already current', async () => {
    const ctx = makeCtx();
    ctx.api.secrets.get = vi.fn(async (k: string) => (k === 'addon_version' ? SIMPLEFIN_SYNC_VERSION : null));
    enable(ctx);
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.api.secrets.set).not.toHaveBeenCalledWith('addon_version', SIMPLEFIN_SYNC_VERSION);
  });

  it('registers an onDisable callback', () => {
    const ctx = makeCtx();
    enable(ctx);
    expect(ctx.onDisable).toHaveBeenCalled();
  });

  it('onDisable stops the scheduler without throwing', () => {
    const ctx = makeCtx();
    enable(ctx);
    expect(() => ctx._triggerDisable()).not.toThrow();
  });
});

// ── SimplefinSyncView behaviour tests ─────────────────────────────────────────

describe('SimplefinSyncView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing while loading (isSetup is null)', () => {
    const store = makeStore();
    // Make the promise never resolve so we stay in loading state
    store.getAccessUrl = vi.fn(() => new Promise(() => {}));
    const { container } = render(
      React.createElement(SimplefinSyncView, { ctx: {} as any, store, scheduler: makeScheduler() }),
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows SetupPage when no accessUrl is stored', async () => {
    const { SetupPage } = await import('./pages/SetupPage');
    render(
      React.createElement(SimplefinSyncView, {
        ctx: {} as any,
        store: makeStore({ accessUrl: null }),
        scheduler: makeScheduler(),
      }),
    );
    await waitFor(() => expect(screen.getByText('SetupPage')).toBeInTheDocument());
    expect(SetupPage).toHaveBeenCalled();
  });

  it('shows SetupPage when mapping is empty (abandoned wizard)', async () => {
    const { SetupPage } = await import('./pages/SetupPage');
    render(
      React.createElement(SimplefinSyncView, {
        ctx: {} as any,
        store: makeStore({ accessUrl: 'https://u:p@bridge.simplefin.org/simplefin', accountMapping: {} }),
        scheduler: makeScheduler(),
      }),
    );
    await waitFor(() => expect(screen.getByText('SetupPage')).toBeInTheDocument());
    expect(SetupPage).toHaveBeenCalled();
  });

  it('shows SetupPage when accessUrl exists but mapping is null', async () => {
    const { SetupPage } = await import('./pages/SetupPage');
    render(
      React.createElement(SimplefinSyncView, {
        ctx: {} as any,
        store: makeStore({ accessUrl: 'https://u:p@bridge.simplefin.org/simplefin', accountMapping: null }),
        scheduler: makeScheduler(),
      }),
    );
    await waitFor(() => expect(screen.getByText('SetupPage')).toBeInTheDocument());
    expect(SetupPage).toHaveBeenCalled();
  });

  it('shows SyncPage when fully configured', async () => {
    const { SyncPage } = await import('./pages/SyncPage');
    render(
      React.createElement(SimplefinSyncView, {
        ctx: {} as any,
        store: makeStore({
          accessUrl: 'https://u:p@bridge.simplefin.org/simplefin',
          accountMapping: { 'sfin-1': 'wf-a' },
          syncScheduleHours: 0,
        }),
        scheduler: makeScheduler(),
      }),
    );
    await waitFor(() => expect(screen.getByText('SyncPage')).toBeInTheDocument());
    expect(SyncPage).toHaveBeenCalled();
  });

  it('starts scheduler when configured with hours > 0 and not running', async () => {
    const scheduler = makeScheduler(false);
    render(
      React.createElement(SimplefinSyncView, {
        ctx: {} as any,
        store: makeStore({
          accessUrl: 'https://u:p@bridge.simplefin.org/simplefin',
          accountMapping: { 'sfin-1': 'wf-a' },
          syncScheduleHours: 6,
        }),
        scheduler,
      }),
    );
    await waitFor(() => expect(screen.getByText('SyncPage')).toBeInTheDocument());
    expect(scheduler.start).toHaveBeenCalledWith(6, expect.any(Function), expect.any(Function));
  });

  it('does NOT start scheduler when hours = 0 (disabled)', async () => {
    const scheduler = makeScheduler(false);
    render(
      React.createElement(SimplefinSyncView, {
        ctx: {} as any,
        store: makeStore({
          accessUrl: 'https://u:p@bridge.simplefin.org/simplefin',
          accountMapping: { 'sfin-1': 'wf-a' },
          syncScheduleHours: 0,
        }),
        scheduler,
      }),
    );
    await waitFor(() => expect(screen.getByText('SyncPage')).toBeInTheDocument());
    expect(scheduler.start).not.toHaveBeenCalled();
    expect(scheduler.stop).toHaveBeenCalled();
  });

  it('does NOT double-start scheduler when already running', async () => {
    const scheduler = makeScheduler(true); // already running
    render(
      React.createElement(SimplefinSyncView, {
        ctx: {} as any,
        store: makeStore({
          accessUrl: 'https://u:p@bridge.simplefin.org/simplefin',
          accountMapping: { 'sfin-1': 'wf-a' },
          syncScheduleHours: 6,
        }),
        scheduler,
      }),
    );
    await waitFor(() => expect(screen.getByText('SyncPage')).toBeInTheDocument());
    expect(scheduler.start).not.toHaveBeenCalled();
  });

  it('transitions to SyncPage and starts scheduler on handleComplete (hours > 0)', async () => {
    const { SetupPage, SyncPage } = await Promise.all([
      import('./pages/SetupPage'),
      import('./pages/SyncPage'),
    ]).then(([sp, syp]) => ({ SetupPage: sp.SetupPage, SyncPage: syp.SyncPage }));

    const scheduler = makeScheduler(false);
    const store = makeStore({ accessUrl: null, accountMapping: null, syncScheduleHours: 6 });

    render(
      React.createElement(SimplefinSyncView, { ctx: {} as any, store, scheduler }),
    );
    await waitFor(() => expect(screen.getByText('SetupPage')).toBeInTheDocument());

    // Grab onComplete passed to SetupPage and call it
    const { onComplete } = (SetupPage as ReturnType<typeof vi.fn>).mock.calls[0][0] as { onComplete: () => Promise<void> };
    await onComplete();

    await waitFor(() => expect(screen.getByText('SyncPage')).toBeInTheDocument());
    expect(scheduler.start).toHaveBeenCalledWith(6, expect.any(Function), expect.any(Function));
  });

  it('transitions to SyncPage without starting scheduler on handleComplete (hours = 0)', async () => {
    const { SetupPage } = await import('./pages/SetupPage');
    const scheduler = makeScheduler(false);
    const store = makeStore({ accessUrl: null, accountMapping: null, syncScheduleHours: 0 });

    render(
      React.createElement(SimplefinSyncView, { ctx: {} as any, store, scheduler }),
    );
    await waitFor(() => expect(screen.getByText('SetupPage')).toBeInTheDocument());

    const { onComplete } = (SetupPage as ReturnType<typeof vi.fn>).mock.calls[0][0] as { onComplete: () => Promise<void> };
    await onComplete();

    await waitFor(() => expect(screen.getByText('SyncPage')).toBeInTheDocument());
    expect(scheduler.start).not.toHaveBeenCalled();
    expect(scheduler.stop).toHaveBeenCalled();
  });

  it('transitions back to SetupPage and stops scheduler on handleReset', async () => {
    const { SyncPage } = await import('./pages/SyncPage');
    const scheduler = makeScheduler(false);

    render(
      React.createElement(SimplefinSyncView, {
        ctx: {} as any,
        store: makeStore({
          accessUrl: 'https://u:p@bridge.simplefin.org/simplefin',
          accountMapping: { 'sfin-1': 'wf-a' },
          syncScheduleHours: 0,
        }),
        scheduler,
      }),
    );
    await waitFor(() => expect(screen.getByText('SyncPage')).toBeInTheDocument());

    // Grab onReset passed to SyncPage and call it
    const { onReset } = (SyncPage as ReturnType<typeof vi.fn>).mock.calls[0][0] as { onReset: () => void };
    onReset();

    await waitFor(() => expect(screen.getByText('SetupPage')).toBeInTheDocument());
    expect(scheduler.stop).toHaveBeenCalled();
  });
});
