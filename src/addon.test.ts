import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Lightweight mocks for DOM / React render — we test wiring, not UI output
// ---------------------------------------------------------------------------

vi.mock('react-dom/client', () => ({
  createRoot: vi.fn(() => ({
    render: vi.fn(),
    unmount: vi.fn(),
  })),
}));

vi.mock('./pages/SetupPage', () => ({ SetupPage: vi.fn(() => null) }));
vi.mock('./pages/SyncPage', () => ({ SyncPage: vi.fn(() => null) }));
vi.mock('./utils/sync', () => ({
  runSync: vi.fn(async () => ({ imported: 0, skipped: 0, errors: [] })),
  MIN_SYNC_INTERVAL_MS: 60 * 60 * 1000, // scheduler.ts imports this constant
}));

import { createRoot } from 'react-dom/client';
import enable from './addon';

// ---------------------------------------------------------------------------
// Helpers to build a minimal AddonContext with configurable store responses
// ---------------------------------------------------------------------------

type StoreOverrides = {
  accessUrl?: string | null;
  accountMapping?: Record<string, string> | null;
  syncScheduleHours?: number | null;
};

function makeCtx(overrides: StoreOverrides = {}) {
  const {
    accessUrl = null,
    accountMapping = null,
    syncScheduleHours = null,
  } = overrides;

  const container = document.createElement('div');

  let routeRenderFn: ((ctx: { root: HTMLElement }) => Promise<void>) | null = null;
  let disableCallback: (() => void) | null = null;

  const ctx = {
    sidebar: {
      addItem: vi.fn(() => ({ remove: vi.fn() })),
    },
    router: {
      add: vi.fn(({ render }: { render: (c: { root: HTMLElement }) => Promise<void> }) => {
        routeRenderFn = render;
      }),
    },
    onDisable: vi.fn((cb: () => void) => {
      disableCallback = cb;
    }),
    api: {
      secrets: {
        get: vi.fn(async (key: string) => {
          if (key === 'simplefin_access_url') return accessUrl;
          if (key === 'account_mapping')
            return accountMapping ? JSON.stringify(accountMapping) : null;
          if (key === 'sync_schedule_hours')
            return syncScheduleHours != null ? String(syncScheduleHours) : null;
          return null;
        }),
        set: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
      },
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), trace: vi.fn(), debug: vi.fn() },
    },
    // helpers exposed for test assertions
    _container: container,
    _triggerRoute: () => routeRenderFn?.({ root: container }),
    _triggerDisable: () => disableCallback?.(),
  } as any;

  return ctx;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('addon enable()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers a sidebar item with id "simplefin-sync"', () => {
    const ctx = makeCtx();
    enable(ctx);
    expect(ctx.sidebar.addItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'simplefin-sync', label: 'SimpleFin Sync' }),
    );
  });

  it('registers a route at /simplefin-sync', () => {
    const ctx = makeCtx();
    enable(ctx);
    expect(ctx.router.add).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/simplefin-sync' }),
    );
  });

  it('registers an onDisable callback', () => {
    const ctx = makeCtx();
    enable(ctx);
    expect(ctx.onDisable).toHaveBeenCalled();
  });

  describe('isSetup check', () => {
    it('renders SetupPage when no accessUrl is stored', async () => {
      const { SetupPage } = await import('./pages/SetupPage');
      const ctx = makeCtx({ accessUrl: null, accountMapping: null });
      enable(ctx);
      await ctx._triggerRoute();
      const rootMock = (createRoot as ReturnType<typeof vi.fn>).mock.results[0].value;
      const [rendered] = rootMock.render.mock.calls[0];
      expect((rendered as any).type).toBe(SetupPage);
    });

    it('renders SetupPage when accessUrl exists but mapping is empty (abandoned wizard)', async () => {
      const { SetupPage } = await import('./pages/SetupPage');
      const ctx = makeCtx({ accessUrl: 'https://token@bridge.simplefin.org/simplefin', accountMapping: {} });
      enable(ctx);
      await ctx._triggerRoute();
      const rootMock = (createRoot as ReturnType<typeof vi.fn>).mock.results[0].value;
      const [rendered] = rootMock.render.mock.calls[0];
      expect((rendered as any).type).toBe(SetupPage);
    });

    it('renders SetupPage when accessUrl exists but mapping is null', async () => {
      const { SetupPage } = await import('./pages/SetupPage');
      const ctx = makeCtx({ accessUrl: 'https://token@bridge.simplefin.org/simplefin', accountMapping: null });
      enable(ctx);
      await ctx._triggerRoute();
      const rootMock = (createRoot as ReturnType<typeof vi.fn>).mock.results[0].value;
      const [rendered] = rootMock.render.mock.calls[0];
      expect((rendered as any).type).toBe(SetupPage);
    });

    it('renders SyncPage when both accessUrl and a non-empty mapping exist', async () => {
      const { SyncPage } = await import('./pages/SyncPage');
      const ctx = makeCtx({
        accessUrl: 'https://token@bridge.simplefin.org/simplefin',
        accountMapping: { 'sfin-1': 'wf-a' },
        syncScheduleHours: 0,
      });
      enable(ctx);
      await ctx._triggerRoute();
      const rootMock = (createRoot as ReturnType<typeof vi.fn>).mock.results[0].value;
      const [rendered] = rootMock.render.mock.calls[0];
      expect((rendered as any).type).toBe(SyncPage);
    });
  });

  describe('scheduler wiring on route render', () => {
    it('does NOT start scheduler when scheduleHours is 0 (disabled)', async () => {
      const { Scheduler } = await import('./utils/scheduler');
      const startSpy = vi.spyOn(Scheduler.prototype, 'start');
      const stopSpy = vi.spyOn(Scheduler.prototype, 'stop');

      const ctx = makeCtx({
        accessUrl: 'https://token@bridge.simplefin.org/simplefin',
        accountMapping: { 'sfin-1': 'wf-a' },
        syncScheduleHours: 0,
      });
      enable(ctx);
      await ctx._triggerRoute();

      expect(startSpy).not.toHaveBeenCalled();
      expect(stopSpy).toHaveBeenCalled();
    });

    it('does NOT start scheduler when scheduleHours is null (never configured)', async () => {
      const { Scheduler } = await import('./utils/scheduler');
      const startSpy = vi.spyOn(Scheduler.prototype, 'start');

      const ctx = makeCtx({
        accessUrl: 'https://token@bridge.simplefin.org/simplefin',
        accountMapping: { 'sfin-1': 'wf-a' },
        syncScheduleHours: null,
      });
      enable(ctx);
      await ctx._triggerRoute();

      expect(startSpy).not.toHaveBeenCalled();
    });

    it('starts scheduler when scheduleHours > 0 and not already running', async () => {
      const { Scheduler } = await import('./utils/scheduler');
      const startSpy = vi.spyOn(Scheduler.prototype, 'start');
      vi.spyOn(Scheduler.prototype, 'isRunning').mockReturnValue(false);

      const ctx = makeCtx({
        accessUrl: 'https://token@bridge.simplefin.org/simplefin',
        accountMapping: { 'sfin-1': 'wf-a' },
        syncScheduleHours: 6,
      });
      enable(ctx);
      await ctx._triggerRoute();

      expect(startSpy).toHaveBeenCalledWith(6, expect.any(Function));
    });

    it('does not double-start scheduler when route is rendered twice', async () => {
      const { Scheduler } = await import('./utils/scheduler');
      const startSpy = vi.spyOn(Scheduler.prototype, 'start');
      // Simulate scheduler already running on second render
      let running = false;
      vi.spyOn(Scheduler.prototype, 'isRunning').mockImplementation(() => running);
      startSpy.mockImplementation(() => { running = true; });

      const ctx = makeCtx({
        accessUrl: 'https://token@bridge.simplefin.org/simplefin',
        accountMapping: { 'sfin-1': 'wf-a' },
        syncScheduleHours: 6,
      });
      enable(ctx);
      await ctx._triggerRoute();
      await ctx._triggerRoute(); // navigate away and back

      expect(startSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('onComplete callback', () => {
    it('starts scheduler and renders SyncPage when scheduleHours > 0', async () => {
      const { SetupPage, SyncPage } = await import('./pages/SetupPage').then(async (sp) => ({
        SetupPage: sp.SetupPage,
        SyncPage: (await import('./pages/SyncPage')).SyncPage,
      }));
      const { Scheduler } = await import('./utils/scheduler');
      const startSpy = vi.spyOn(Scheduler.prototype, 'start');

      // Start with no setup, scheduleHours will be 6 after wizard completes
      const ctx = makeCtx({ accessUrl: null, accountMapping: null, syncScheduleHours: 6 });
      enable(ctx);
      await ctx._triggerRoute();

      const rootMock = (createRoot as ReturnType<typeof vi.fn>).mock.results[0].value;
      // Grab the onComplete handler passed to SetupPage
      const firstRenderArg = rootMock.render.mock.calls[0][0] as any;
      expect(firstRenderArg.type).toBe(SetupPage);
      const { onComplete } = firstRenderArg.props as { onComplete: () => Promise<void> };

      // Simulate wizard completion
      await onComplete();

      const lastRenderArg = rootMock.render.mock.lastCall?.[0] as any;
      expect(lastRenderArg.type).toBe(SyncPage);
      expect(startSpy).toHaveBeenCalledWith(6, expect.any(Function));
    });

    it('does NOT start scheduler and renders SyncPage when scheduleHours is 0', async () => {
      const { SetupPage, SyncPage } = await import('./pages/SetupPage').then(async (sp) => ({
        SetupPage: sp.SetupPage,
        SyncPage: (await import('./pages/SyncPage')).SyncPage,
      }));
      const { Scheduler } = await import('./utils/scheduler');
      const startSpy = vi.spyOn(Scheduler.prototype, 'start');
      const stopSpy = vi.spyOn(Scheduler.prototype, 'stop');

      const ctx = makeCtx({ accessUrl: null, accountMapping: null, syncScheduleHours: 0 });
      enable(ctx);
      await ctx._triggerRoute();

      const rootMock = (createRoot as ReturnType<typeof vi.fn>).mock.results[0].value;
      const firstRenderArg = rootMock.render.mock.calls[0][0] as any;
      const { onComplete } = firstRenderArg.props as { onComplete: () => Promise<void> };
      await onComplete();

      const lastRenderArg = rootMock.render.mock.lastCall?.[0] as any;
      expect(lastRenderArg.type).toBe(SyncPage);
      expect(startSpy).not.toHaveBeenCalled();
      expect(stopSpy).toHaveBeenCalled();
    });
  });

  describe('onReset callback', () => {
    it('stops scheduler and renders SetupPage', async () => {
      const { SetupPage, SyncPage } = await import('./pages/SetupPage').then(async (sp) => ({
        SetupPage: sp.SetupPage,
        SyncPage: (await import('./pages/SyncPage')).SyncPage,
      }));
      const { Scheduler } = await import('./utils/scheduler');
      const stopSpy = vi.spyOn(Scheduler.prototype, 'stop');
      vi.spyOn(Scheduler.prototype, 'isRunning').mockReturnValue(false);

      const ctx = makeCtx({
        accessUrl: 'https://token@bridge.simplefin.org/simplefin',
        accountMapping: { 'sfin-1': 'wf-a' },
        syncScheduleHours: 0,
      });
      enable(ctx);
      await ctx._triggerRoute();

      const rootMock = (createRoot as ReturnType<typeof vi.fn>).mock.results[0].value;
      const firstRenderArg = rootMock.render.mock.calls[0][0] as any;
      expect(firstRenderArg.type).toBe(SyncPage);
      const { onReset } = firstRenderArg.props as { onReset: () => void };
      onReset();

      const lastRenderArg = rootMock.render.mock.lastCall?.[0] as any;
      expect(lastRenderArg.type).toBe(SetupPage);
      expect(stopSpy).toHaveBeenCalled();
    });
  });

  describe('onDisable cleanup', () => {
    it('stops scheduler, unmounts root, and removes sidebar item', async () => {
      const { Scheduler } = await import('./utils/scheduler');
      const stopSpy = vi.spyOn(Scheduler.prototype, 'stop');

      const ctx = makeCtx();
      enable(ctx);
      await ctx._triggerRoute();

      const rootMock = (createRoot as ReturnType<typeof vi.fn>).mock.results[0].value;
      const sidebarHandle = ctx.sidebar.addItem.mock.results[0].value;

      ctx._triggerDisable();

      expect(stopSpy).toHaveBeenCalled();
      expect(rootMock.unmount).toHaveBeenCalled();
      expect(sidebarHandle.remove).toHaveBeenCalled();
    });

    it('does not throw if disable is called before route is ever rendered', () => {
      const ctx = makeCtx();
      enable(ctx);
      expect(() => ctx._triggerDisable()).not.toThrow();
    });
  });
});
