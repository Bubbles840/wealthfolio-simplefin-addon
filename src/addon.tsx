import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { AddonContext, AddonEnableFunction } from '@wealthfolio/addon-sdk';
import { SetupPage } from './pages/SetupPage';
import { SyncPage } from './pages/SyncPage';
import { SecretsStore } from './utils/secrets';
import { Scheduler } from './utils/scheduler';
import { runSync } from './utils/sync';
import { ThemeStyles } from './components/ui';

// ── Module-level singletons set by enable() ───────────────────────────────────

let addonCtx: AddonContext | undefined;
let addonStore: SecretsStore | undefined;
let addonScheduler: Scheduler | undefined;

// ── Testable view component ───────────────────────────────────────────────────

export interface SimplefinSyncViewProps {
  ctx: AddonContext;
  store: SecretsStore;
  scheduler: Scheduler;
}

export function SimplefinSyncView({ ctx, store, scheduler }: SimplefinSyncViewProps) {
  const [isSetup, setIsSetup] = useState<boolean | null>(null);

  useEffect(() => {
    Promise.all([store.getAccessUrl(), store.getAccountMapping()]).then(
      ([accessUrl, mapping]) => {
        const setup = !!accessUrl && !!mapping && Object.keys(mapping).length > 0;
        if (setup) {
          store.getSyncScheduleHours().then((hours) => {
            if (hours && hours > 0 && !scheduler.isRunning()) {
              scheduler.start(hours, () => runSync(ctx, store));
            } else if (!hours || hours <= 0) {
              scheduler.stop();
            }
          });
        }
        setIsSetup(setup);
      },
    );
  }, [ctx, store, scheduler]);

  if (isSetup === null) return <ThemeStyles />;

  const handleComplete = async () => {
    const hours = await store.getSyncScheduleHours();
    if (hours && hours > 0 && !scheduler.isRunning()) {
      scheduler.start(hours, () => runSync(ctx, store));
    } else {
      scheduler.stop();
    }
    setIsSetup(true);
  };

  const handleReset = () => {
    scheduler.stop();
    setIsSetup(false);
  };

  return (
    <>
      <ThemeStyles />
      {!isSetup ? (
        <SetupPage ctx={ctx} store={store} onComplete={handleComplete} />
      ) : (
        <SyncPage ctx={ctx} store={store} scheduler={scheduler} onReset={handleReset} />
      )}
    </>
  );
}

// ── Addon entry point ─────────────────────────────────────────────────────────

const enable: AddonEnableFunction = (ctx) => {
  addonCtx = ctx;
  addonStore = new SecretsStore(ctx);
  addonScheduler = new Scheduler();

  const sidebarItem = ctx.sidebar.addItem({
    id: 'simplefin-sync',
    label: 'SimpleFin Sync',
    // Host-drawn icon set has no wave like SimpleFin's logo; 'bank' reads as
    // "bank connection" and doesn't collide with Wealthfolio's own sidebar
    // icons (chart-line-up is already Insights)
    icon: 'bank',
    route: '/addons/simplefin-sync',
    order: 90,
  });

  let root: ReturnType<typeof createRoot> | undefined;

  ctx.router.add({
    path: '/addons/simplefin-sync',
    render: ({ root: routeRoot }) => {
      root ??= createRoot(routeRoot);
      root.render(
        <SimplefinSyncView ctx={addonCtx!} store={addonStore!} scheduler={addonScheduler!} />,
      );
    },
  });

  ctx.onDisable(() => {
    addonScheduler!.stop();
    root?.unmount();
    sidebarItem.remove();
    addonCtx = undefined;
    addonStore = undefined;
    addonScheduler = undefined;
    root = undefined;
  });
};

export default enable;
