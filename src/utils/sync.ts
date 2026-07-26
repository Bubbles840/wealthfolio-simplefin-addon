import { AddonSyncHost } from './addon-host';
import { importAdjustmentActivity, runSyncCore } from '../../shared/sync-core';
import type { SyncOptions, SyncResult } from '../../shared/sync-core';
import type { SecretsStore } from './secrets';
import type { AddonContext } from '@wealthfolio/addon-sdk';

// The sync logic itself lives in shared/sync-core.ts so the Docker companion can
// reuse it behind the same SyncHost interface. These re-exports keep the addon's
// existing import sites (and their tests) pointing at ./utils/sync.
export type { SyncOptions, SyncResult } from '../../shared/sync-core';
export {
  MIN_SYNC_INTERVAL_MS,
  SYNC_LOOKBACK_OVERLAP_MS,
  DRIFT_THRESHOLD_DOLLARS,
  HEAL_WINDOW_MS,
  AUTO_HEAL_WINDOW_MS,
  VALUATION_POLL,
  INTERVAL_SKIP_MESSAGE,
  PENDING_SUFFIX,
  TRANSFER_GROUP_PREFIX,
  INTERNAL_TRANSFER_METADATA,
  txEpoch,
  txIdFromComment,
  isTransferType,
  neutralAdjustmentFields,
} from '../../shared/sync-core';

// Single-flight lock: the startup catch-up, the in-app schedule, and the
// Sync Now button can otherwise overlap in the first seconds after load —
// concurrent runs could each pass the pre-import checks before the other's
// writes land. Concurrent callers share the in-progress run's result.
let syncInFlight: Promise<SyncResult> | null = null;

export function runSync(
  ctx: AddonContext,
  store: SecretsStore,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = runSyncCore(new AddonSyncHost(ctx), store, opts).finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

/**
 * Manual "Add adjustment" button: true one account to SimpleFin's balance by
 * importing a one-time balance-adjustment entry for the residual the heal
 * re-scan couldn't recover, then clear its stored drift so the Sync page
 * updates immediately.
 */
export async function applyBalanceAdjustment(
  ctx: AddonContext,
  store: SecretsStore,
  args: { sfinAccountId: string; wfAccountId: string; currency: string; amount: number },
): Promise<void> {
  if (!Number.isFinite(args.amount) || Math.abs(args.amount) < 0.01) return;
  await importAdjustmentActivity(new AddonSyncHost(ctx), args);
  // Clear the stored drift so the Sync page reflects the fix immediately.
  const balances = await store.getAccountBalances();
  if (balances[args.sfinAccountId]) {
    balances[args.sfinAccountId] = { ...balances[args.sfinAccountId], drift: null };
    await store.setAccountBalances(balances);
  }
}
