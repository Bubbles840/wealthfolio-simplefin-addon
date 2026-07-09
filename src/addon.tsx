import React from 'react';
import { createRoot } from 'react-dom/client';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { SetupPage } from './pages/SetupPage';
import { SyncPage } from './pages/SyncPage';
import { SecretsStore } from './utils/secrets';
import { Scheduler } from './utils/scheduler';
import { runSync } from './utils/sync';

export default function enable(ctx: AddonContext) {
  const store = new SecretsStore(ctx);
  const scheduler = new Scheduler();
  let root: ReturnType<typeof createRoot> | null = null;

  const sidebarItem = ctx.sidebar.addItem({
    id: 'simplefin-sync',
    label: 'SimpleFin Sync',
    route: '/simplefin-sync',
    order: 90,
  });

  ctx.router.add({
    path: '/simplefin-sync',
    title: 'SimpleFin Sync',
    render: async ({ root: container }) => {
      // Reuse the root across re-renders of the same route
      root ??= createRoot(container);

      // isSetup requires BOTH an access URL and at least one mapped account.
      // Checking only accessUrl would show SyncPage after an abandoned mid-flow setup.
      const [accessUrl, mapping] = await Promise.all([
        store.getAccessUrl(),
        store.getAccountMapping(),
      ]);
      const isSetup = !!accessUrl && !!mapping && Object.keys(mapping).length > 0;

      // Start or stop the background scheduler based on stored preference.
      // scheduleHours === 0 (or null) means disabled — never call scheduler.start(0)
      // because Scheduler clamps to 1 hr and keeps ticking even when the user disabled it.
      if (isSetup) {
        const hours = await store.getSyncScheduleHours();
        if (hours && hours > 0) {
          if (!scheduler.isRunning()) {
            scheduler.start(hours, () => runSync(ctx, store));
          }
        } else {
          scheduler.stop();
        }
      }

      renderView(isSetup);
    },
  });

  function renderView(isSetup: boolean): void {
    if (!root) return;
    if (!isSetup) {
      root.render(
        <SetupPage
          ctx={ctx}
          store={store}
          onComplete={handleComplete}
        />,
      );
    } else {
      root.render(
        <SyncPage
          ctx={ctx}
          store={store}
          scheduler={scheduler}
          onReset={handleReset}
        />,
      );
    }
  }

  // Called by SetupPage when the user completes the wizard.
  // Read the schedule the user configured, wire up the scheduler, then show SyncPage.
  async function handleComplete(): Promise<void> {
    const hours = await store.getSyncScheduleHours();
    if (hours && hours > 0 && !scheduler.isRunning()) {
      scheduler.start(hours, () => runSync(ctx, store));
    } else {
      // scheduleHours === 0 or null → auto-sync disabled
      scheduler.stop();
    }
    renderView(true);
  }

  // Called by SyncPage when the user resets / disconnects.
  // Stop any running scheduler and return to the setup wizard.
  function handleReset(): void {
    scheduler.stop();
    renderView(false);
  }

  ctx.onDisable(() => {
    scheduler.stop();
    root?.unmount();
    root = null;
    sidebarItem.remove();
  });
}
