import { AddonSyncHost } from './addon-host';
import { importAdjustmentActivity, runSyncCore } from '../../shared/sync-core';
import type { SyncOptions, SyncResult } from '../../shared/sync-core';
import {
  sendTelegramMessage,
  formatStuckTransferAlert,
  formatBalanceDriftAlert,
  formatLargeTransactionAlert,
  formatDuplicatePruneAlert,
} from '../../shared/telegram';
import type { PendingLargeTxAlert, SecretsStore } from './secrets';
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
  syncInFlight = (async () => {
    const result = await runSyncCore(new AddonSyncHost(ctx), store, opts);
    // Deliver INSIDE the single-flight lock and inside the returned promise, so
    // one run announces its own alerts exactly once and a caller that awaits the
    // sync has also awaited the sends. `deliverAddonAlerts` never rejects, so it
    // cannot turn a successful sync into a failed one; a core that throws skips
    // delivery entirely, which is correct — it produced no alerts to deliver.
    await deliverAddonAlerts(ctx, store, result);
    return result;
  })().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

/** Telegram settings, as far as delivery cares. Read through the store so the
 *  addon and the companion honour the same `enabled === false` opt-out. */
interface TelegramTarget {
  botToken: string;
  chatId: string;
}

/**
 * Reads `telegram_config` and reports the send target, or `null` for a
 * "non-attempt": no config, an unreadable one, missing credentials, or Telegram
 * deliberately disabled.
 *
 * A non-attempt is NOT a delivery failure, and the distinction decides whether
 * the ledgers get touched at all — see `deliverAddonAlerts`.
 */
async function telegramTarget(store: SecretsStore): Promise<TelegramTarget | null> {
  // The store's getter does a bare JSON.parse, so a truncated or hand-edited
  // secret throws. Treated as absent, matching the companion's parseSecretJson:
  // there is no token to send with either way, and no retry fixes it.
  const tg = await store.getTelegramConfig().catch(() => null);
  if (!tg || !tg.botToken || !tg.chatId || tg.enabled === false) return null;
  return { botToken: String(tg.botToken), chatId: String(tg.chatId) };
}

/**
 * Sends this run's three alert arrays from the addon, and keeps the shared
 * ledgers honest about what actually arrived.
 *
 * WHY THIS EXISTS. `runSyncCore` is the same code on both hosts, and it CONSUMES
 * an alert as it emits it: it writes `transfer_link_failures[key].alerted = true`
 * and `drift_alerts[id].alerted = true` before returning, and a large-transaction
 * alert exists only because the row was created this run. Until now only the
 * companion sent anything, so an in-app sync that won the race — this addon syncs
 * on app-open and on an in-app schedule, so it very often does — marked episodes
 * delivered that nobody had announced (the companion then skipped them, because
 * the ledger said the user had been told) and dropped every large-transaction
 * alert on the floor, unrecoverably, since `planReconciliation` creates a given
 * SimpleFin tx id exactly once.
 *
 * WHY DUPLICATES ARE STILL IMPOSSIBLE. Both syncers read and write the same addon
 * secrets on the one Wealthfolio instance, so the ledger is the interlock:
 *  - stuck transfer — the core only emits when the entry's `alerted` is false, and
 *    flips it true in the same pass. Whoever runs first is the only one that can
 *    emit; the other's core sees `alerted: true` and emits nothing.
 *  - balance drift — identical shape, keyed per account: emitted only when opening
 *    an episode or when a previous run rolled `alerted` back.
 *  - large transaction — emitted once per SimpleFin tx id by whichever syncer
 *    created the row, and the outbox below is merged BY tx id, so a queued retry
 *    and a fresh report of the same transaction collapse to one send.
 * The one caveat is inherent to the shared ledger rather than to this function:
 * these are read-modify-write cycles on a secret with no compare-and-swap, so two
 * syncers running in the same instant could both observe `alerted: false`. In
 * practice the companion is on a cron and the addon holds a single-flight lock
 * plus a one-hour interval floor.
 *
 * FORMATTING IS NOT DUPLICATED. Every string comes from `shared/telegram.ts`, the
 * same builders the companion calls, so the two syncers cannot drift in what they
 * say — and the escaping of bank descriptions and account names travels with them.
 * Only sending (`ctx.api.network` here, Node `fetch` there) and the ledger
 * bookkeeping differ.
 *
 * Never throws: a notification problem must not be reported as a sync failure.
 */
export async function deliverAddonAlerts(
  ctx: AddonContext,
  store: SecretsStore,
  result: SyncResult,
): Promise<void> {
  const { stuckTransferAlerts, largeTransactionAlerts, balanceDriftAlerts, prunedDuplicates } = result;
  try {
    // Nothing to say and nothing queued: don't spend a secret read on it. The
    // outbox is only consulted when this run has an alert of its own, which is
    // the same cadence the companion drains it at.
    if (
      stuckTransferAlerts.length === 0
      && largeTransactionAlerts.length === 0
      && balanceDriftAlerts.length === 0
      && prunedDuplicates.length === 0
    ) return;

    const target = await telegramTarget(store);
    // A non-attempt does NOTHING: no sends, no rollbacks, no outbox write. This
    // is deliberately the pre-existing behaviour for an addon with no Telegram
    // config. Rolling the ledgers back on every sync would rewrite two secrets
    // forever to re-queue alerts that can never be delivered, and queueing into
    // the outbox would grow an unbounded backlog for a user who opted out — the
    // same tradeoff, for the same reason, as the companion's non-attempt path.
    if (!target) return;

    const network = ctx.api.network;
    const send = (text: string) =>
      sendTelegramMessage(target.botToken, target.chatId, text, network);

    // ── Stuck transfers ─────────────────────────────────────────────────────
    // `sendTelegramMessage` reports an API-level rejection (bad token, rate
    // limit, a 400 from unbalanced Markdown) by RESOLVING `{ ok: false }`, so a
    // caller that ignores the result marks delivered what never arrived.
    const undeliveredOutTxIds: string[] = [];
    for (const alert of stuckTransferAlerts) {
      const res = await send(formatStuckTransferAlert(alert));
      if (!res.ok) {
        console.warn(`[simplefin-sync] stuck-transfer alert not delivered, will retry next sync: ${res.description}`);
        undeliveredOutTxIds.push(alert.outTxId);
      }
    }
    await rollBackUndeliveredStuckTransfers(store, undeliveredOutTxIds);

    // ── Large transactions ──────────────────────────────────────────────────
    await deliverLargeTransactionAlerts(store, send, largeTransactionAlerts);

    // ── Balance drift ───────────────────────────────────────────────────────
    const undeliveredDriftAccountIds: string[] = [];
    for (const alert of balanceDriftAlerts) {
      const res = await send(formatBalanceDriftAlert(alert));
      if (!res.ok) {
        console.warn(`[simplefin-sync] balance-drift alert not delivered, will retry next sync: ${res.description}`);
        undeliveredDriftAccountIds.push(alert.sfinAccountId);
      }
    }
    await rollBackUndeliveredDriftAlerts(store, undeliveredDriftAccountIds);

    // ── Pruned duplicates ───────────────────────────────────────────────────
    // ONE message for the whole sweep, not one per row: a reconcile that cleans
    // up a long-neglected account would otherwise arrive as a burst of pings.
    // No ledger and no rollback — unlike the three alerts above there is no
    // episode to re-arm and nothing to mark, and the rows themselves are already
    // gone. A failed send is logged and not retried; the deletions are also
    // logged line-by-line by the core and shown on the Sync page, so Telegram is
    // not the only record.
    if (prunedDuplicates.length > 0) {
      const res = await send(formatDuplicatePruneAlert(prunedDuplicates));
      if (!res.ok) {
        console.warn(`[simplefin-sync] duplicate-prune notice not delivered: ${res.description}`);
      }
    }
  } catch (err) {
    console.warn('[simplefin-sync] alert delivery failed', err);
  }
}

/**
 * Re-reads the transfer-link-failures ledger — never a stale in-memory copy,
 * since `runSyncCore` already wrote it this run and writing back an older view
 * would clobber that — and clears `alerted` for exactly the entries whose send
 * failed, so the next run re-queues them.
 *
 * `count` and `firstFailedAt` are preserved: re-arming delivery is not the same
 * as declaring the transfer healthy, and resetting the streak would push the
 * 3-strike threshold back out of reach. Writes only on a real change, and never
 * throws — the alert simply stays marked delivered until the next run tries again.
 */
async function rollBackUndeliveredStuckTransfers(
  store: SecretsStore,
  undeliveredOutTxIds: string[],
): Promise<void> {
  if (undeliveredOutTxIds.length === 0) return;
  try {
    const failures = await store.getTransferLinkFailures();
    let changed = false;
    for (const outTxId of undeliveredOutTxIds) {
      if (failures[outTxId]?.alerted) {
        failures[outTxId] = { ...failures[outTxId], alerted: false };
        changed = true;
      }
    }
    if (changed) await store.setTransferLinkFailures(failures);
  } catch (err) {
    console.warn('[simplefin-sync] stuck-transfer alert rollback failed', err);
  }
}

/** As above for the drift ledger, keyed by SimpleFin account id.
 *  `driftAmount`/`firstDetectedAt` stay put so the EPISODE survives the rollback. */
async function rollBackUndeliveredDriftAlerts(
  store: SecretsStore,
  undeliveredAccountIds: string[],
): Promise<void> {
  if (undeliveredAccountIds.length === 0) return;
  try {
    const alerts = await store.getDriftAlerts();
    let changed = false;
    for (const sfinAccountId of undeliveredAccountIds) {
      if (alerts[sfinAccountId]?.alerted) {
        alerts[sfinAccountId] = { ...alerts[sfinAccountId], alerted: false };
        changed = true;
      }
    }
    if (changed) await store.setDriftAlerts(alerts);
  } catch (err) {
    console.warn('[simplefin-sync] balance-drift alert rollback failed', err);
  }
}

/**
 * Sends this run's large-transaction alerts plus anything an earlier run (or the
 * companion) left queued, and persists exactly what is still undelivered.
 *
 * An outbox rather than the roll-back-a-flag pattern the other two use, because
 * this alert is not re-derivable: it exists only because the row was CREATED, and
 * a given SimpleFin tx id is created exactly once. Merged BY tx id so a queued
 * retry and a re-report of the same transaction cannot both be sent.
 *
 * Note the ordering risk, which is the same on both hosts and deliberately
 * accepted: the queue is written AFTER the sends, so a successful send followed
 * by a failed secret write leaves the entry queued and it is re-sent next run.
 * At-least-once beats at-most-once here — a duplicate alert is noise, a dropped
 * one is a large charge the user never hears about.
 */
async function deliverLargeTransactionAlerts(
  store: SecretsStore,
  send: (text: string) => Promise<{ ok: boolean; description?: string }>,
  alerts: PendingLargeTxAlert[],
): Promise<void> {
  try {
    const queued = await store.getPendingLargeTxAlerts();
    const pending = [...queued];
    for (const alert of alerts) {
      if (!pending.some((q) => q.txId === alert.txId)) pending.push(alert);
    }
    if (pending.length === 0) return;

    const undelivered: PendingLargeTxAlert[] = [];
    for (const alert of pending) {
      const res = await send(formatLargeTransactionAlert(alert));
      if (!res.ok) {
        console.warn(`[simplefin-sync] large-transaction alert not delivered, will retry next sync: ${res.description}`);
        undelivered.push(alert);
      }
    }

    // Only write when the stored queue actually changes, matching the
    // `linkFailuresChanged` discipline runSyncCore uses for its own ledgers.
    const changed =
      undelivered.length !== queued.length
      || undelivered.some((a, i) => a.txId !== queued[i]?.txId);
    if (changed) await store.setPendingLargeTxAlerts(undelivered);
  } catch (err) {
    console.warn('[simplefin-sync] large-transaction alert delivery failed', err);
  }
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
