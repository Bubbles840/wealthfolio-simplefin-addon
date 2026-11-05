/**
 * companion/src/home-assistant-host.ts
 *
 * The companion's half of Home Assistant alerts (shared/home-assistant.ts):
 * queueing this run's alerts, and draining the outbox both writers fill. Only the
 * companion sends, because only it can reach a Home Assistant address.
 */
import {
  drainHaOutbox, HA_CONFIG_SECRET_KEY, mergeDrained, HA_OUTBOX_SECRET_KEY, HA_STATUS_SECRET_KEY, parseHaOutbox, parseHaStatus,
  parseHomeAssistantConfig, queueHaEntries, sendHomeAssistantNotification, syncAlertEntries, syncHealthEntry,
  type HaSecretIo, type HaStatus,
} from '../../shared/home-assistant.js';
import type { SyncResult } from '../../shared/sync-core.js';

const ADDON_ID = 'simplefin-sync';

/** The secret reads and writes the shared module needs, over REST. */
export function haSecretIo(client: {
  getAddonSecret(addonId: string, key: string): Promise<string | null>;
  setAddonSecret(addonId: string, key: string, value: string): Promise<void>;
}): HaSecretIo {
  return {
    get: (key) => client.getAddonSecret(ADDON_ID, key),
    set: (key, value) => client.setAddonSecret(ADDON_ID, key, value),
  };
}

/** Queues this run's alerts. A no-op when Home Assistant is not set up. */
export function queueSyncAlertsForHomeAssistant(io: HaSecretIo, result: SyncResult, now = new Date()): Promise<void> {
  return queueHaEntries(io, (known) => syncAlertEntries(result, now, known), now);
}

/** Queues the sync-failing alert for a streak that has run past the alert age.
 *  Once per streak: the entry's id is the streak's start. */
export function queueSyncHealthForHomeAssistant(
  io: HaSecretIo,
  firstFailedAt: string,
  lastError: string | undefined,
  now = new Date(),
): Promise<void> {
  return queueHaEntries(io, () => [syncHealthEntry(firstFailedAt, lastError, now)], now);
}

let inFlight: Promise<number> | null = null;

/**
 * Sends what is queued, and records the outcome in `ha_status` for the add-on's
 * settings to show. Returns how many were delivered. Throws only when a secret
 * cannot be read, so the caller can sign in again and retry. One drain at a
 * time: the after-sync drain and the 5-minute one would otherwise both send the
 * same alert.
 */
export function drainHomeAssistant(
  io: HaSecretIo,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<number> {
  inFlight ??= drainOnce(io, fetchImpl, now).finally(() => { inFlight = null; });
  return inFlight;
}

async function drainOnce(io: HaSecretIo, fetchImpl: typeof fetch, now: Date): Promise<number> {
  const config = parseHomeAssistantConfig(await io.get(HA_CONFIG_SECRET_KEY));
  if (!config) return 0;
  const raw = await io.get(HA_OUTBOX_SECRET_KEY);
  const outbox = parseHaOutbox(raw);
  if (outbox.pending.length === 0) return 0;

  const result = await drainHaOutbox(outbox, (entry) => sendHomeAssistantNotification(config, entry, fetchImpl), now);
  // Re-read: the add-on may have queued more while the sends ran.
  const latest = await io.get(HA_OUTBOX_SECRET_KEY).catch(() => raw);
  const json = JSON.stringify(mergeDrained(parseHaOutbox(latest), result.outbox, now));
  if (json !== latest) await io.set(HA_OUTBOX_SECRET_KEY, json).catch(() => {});

  const previous = parseHaStatus(await io.get(HA_STATUS_SECRET_KEY).catch(() => null)) ?? {};
  const lastOkAt = result.delivered > 0 ? now.toISOString() : previous.lastOkAt;
  const status: HaStatus = result.error
    ? { ...(lastOkAt ? { lastOkAt } : {}), lastError: result.error, lastErrorAt: now.toISOString() }
    : { lastOkAt };
  await io.set(HA_STATUS_SECRET_KEY, JSON.stringify(status)).catch(() => {});
  return result.delivered;
}
