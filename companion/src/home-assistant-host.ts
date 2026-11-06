/**
 * companion/src/home-assistant-host.ts
 *
 * The companion's half of Home Assistant alerts (shared/home-assistant.ts):
 * queueing this run's alerts, and draining what both writers queued. Only the
 * companion sends, because only it can reach a Home Assistant address.
 */
import {
  drainHaOutbox, HA_ADDON_QUEUE_SECRET_KEY, HA_CONFIG_SECRET_KEY, HA_OUTBOX_SECRET_KEY, HA_STATUS_SECRET_KEY,
  haDrainMode, haPendingView, haUntriedTest, mergeDrained, nextHaStatus, parseHaOutbox, parseHaStatus, parseHomeAssistantConfig,
  queueHaEntries, sendHomeAssistantNotification, syncAlertEntries, syncHealthEntry, type HaSecretIo,
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
  return queueHaEntries(io, 'companion', (known, config) => syncAlertEntries(result, now, known, config), now);
}

/** Queues the sync-failing alert for a streak that has run past the alert age.
 *  Once per streak: the entry's id is the streak's start. */
export function queueSyncHealthForHomeAssistant(
  io: HaSecretIo,
  firstFailedAt: string,
  lastError: string | undefined,
  now = new Date(),
): Promise<void> {
  return queueHaEntries(io, 'companion', () => [syncHealthEntry(firstFailedAt, lastError, now)], now);
}

/** While Home Assistant is not set up, the 5-minute drain looks again this often
 *  instead of every tick. */
export const HA_IDLE_RECHECK_MS = 15 * 60 * 1000;

/** What the last config read found: whether Home Assistant is set up, and when. */
let lastSeen: { setUp: boolean; at: number } | null = null;

/**
 * For the 5-minute drain: whether to read anything this tick. True while Home
 * Assistant is set up (or was never checked); otherwise once per
 * `HA_IDLE_RECHECK_MS`, so an install without it reads nothing most ticks.
 */
export function haDrainDue(now = Date.now()): boolean {
  return !lastSeen || lastSeen.setUp || now - lastSeen.at >= HA_IDLE_RECHECK_MS;
}

/** Whether the last config read found Home Assistant set up. The 5-minute drain
 *  logs and signs in again only then: someone without it hears nothing. */
export function haKnownSetUp(): boolean {
  return lastSeen?.setUp === true;
}

/** Ids this process delivered, and when: if writing `seen` fails after a send,
 *  the next drain records them instead of sending them again. A day covers any
 *  write that fails for a while; the companion restarting forgets them, which
 *  costs at most a repeat. */
const deliveredHere = new Map<string, number>();
const DELIVERED_MEMORY_MS = 24 * 60 * 60 * 1000;

/** Tests only. */
export function resetHaDrainMemory(): void {
  lastSeen = null;
  deliveredHere.clear();
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
  lastSeen = { setUp: !!config, at: now.getTime() };
  if (!config) return 0;
  // Every read must succeed: an unreadable status would read as "nothing holds
  // delivery back" and send through a park.
  const [raw, addonRaw, statusRaw] = await Promise.all([
    io.get(HA_OUTBOX_SECRET_KEY), io.get(HA_ADDON_QUEUE_SECRET_KEY), io.get(HA_STATUS_SECRET_KEY),
  ]);
  const view = haPendingView(parseHaOutbox(raw), parseHaOutbox(addonRaw), now);
  if (view.pending.length === 0) return 0;

  const t = now.getTime();
  for (const [id, at] of deliveredHere) if (t - at > DELIVERED_MEMORY_MS) deliveredHere.delete(id);
  const previous = parseHaStatus(statusRaw);
  const mode = haDrainMode(previous, config, view.pending, now);
  // Waiting: only age out, and count, what is too old. Tests only: the untried
  // tests, never the alert that failed.
  const result = await drainHaOutbox(
    view,
    mode === 'wait' ? null : async (entry) => {
      const res = await sendHomeAssistantNotification(config, entry, fetchImpl);
      if (res.ok) deliveredHere.set(entry.id, t);
      return res;
    },
    now,
    {
      alreadySent: (id) => deliveredHere.has(id),
      ...(mode === 'tests' ? { only: (entry) => haUntriedTest(previous, entry) } : {}),
    },
  );
  // Re-read: this companion's own sync may have queued more while the sends ran.
  // A failed re-read or write throws instead of writing an older copy, which
  // would lose what was queued meanwhile; `deliveredHere` keeps the next drain
  // from sending again what went out. The add-on's key is never written here.
  const latest = await io.get(HA_OUTBOX_SECRET_KEY);
  const json = JSON.stringify(mergeDrained(parseHaOutbox(latest), result.outbox, now));
  if (json !== latest) await io.set(HA_OUTBOX_SECRET_KEY, json);

  const status = nextHaStatus(previous, result, config, now);
  if (status) await io.set(HA_STATUS_SECRET_KEY, JSON.stringify(status));
  return result.delivered;
}
