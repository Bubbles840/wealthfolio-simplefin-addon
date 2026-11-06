/**
 * companion/src/home-assistant-host.ts
 *
 * The companion's half of Home Assistant alerts (shared/home-assistant.ts):
 * queueing this run's alerts, and draining what both writers queued. Only the
 * companion sends, because only it can reach a Home Assistant address.
 */
import {
  drainHaOutbox, HA_ADDON_QUEUE_SECRET_KEY, HA_CONFIG_SECRET_KEY, HA_OUTBOX_SECRET_KEY,
  haDrainMode, haPendingView, haUntriedTest, mergeDrained, nextHaStatus, parseHaOutbox, parseHomeAssistantConfig,
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

/**
 * Every read-modify-write of `ha_outbox` in this process, one at a time: the
 * sync's queueing and a drain's final write each read it and write it back, and
 * interleaved, the later write would drop what the earlier one recorded (sent
 * alerts would go out again, the status would go back). Sends happen outside it.
 */
let outboxChain: Promise<unknown> = Promise.resolve();
function withOutboxLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = outboxChain.then(fn, fn);
  outboxChain = run.catch(() => {});
  return run;
}

/** Queues this run's alerts. A no-op when Home Assistant is not set up. */
export function queueSyncAlertsForHomeAssistant(io: HaSecretIo, result: SyncResult, now = new Date()): Promise<void> {
  return withOutboxLock(() => queueHaEntries(io, 'companion', (known, config) => syncAlertEntries(result, now, known, config), now));
}

/** Queues the sync-failing alert for a streak that has run past the alert age.
 *  Once per streak: the entry's id is the streak's start. */
export function queueSyncHealthForHomeAssistant(
  io: HaSecretIo,
  firstFailedAt: string,
  lastError: string | undefined,
  now = new Date(),
): Promise<void> {
  return withOutboxLock(() => queueHaEntries(io, 'companion', () => [syncHealthEntry(firstFailedAt, lastError, now)], now));
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
 *  logs only then: someone without it hears nothing. */
export function haKnownSetUp(): boolean {
  return lastSeen?.setUp === true;
}

/** Whether the last config read found Home Assistant NOT set up (unknown is
 *  neither). */
export function haKnownNotSetUp(): boolean {
  return lastSeen?.setUp === false;
}

/** Tests only. */
export function resetHaDrainMemory(): void {
  lastSeen = null;
  rerun = false;
  inFlight = null;
  outboxChain = Promise.resolve();
}

let inFlight: Promise<number> | null = null;
/** A drain was asked for while one ran: its reads may predate what was just
 *  queued, so one more pass follows, with the client that started the drain
 *  (known to work) and the time then. */
let rerun = false;

/**
 * Sends what is queued, and records it and the outcome in `ha_outbox` (the
 * status is what the add-on's settings show). Returns how many it sent. Rejects
 * when a secret cannot be read or written, so the caller can sign in again and
 * retry. One drain at a time: the after-sync drain and the 5-minute one would
 * otherwise both send the same alert.
 */
export function drainHomeAssistant(io: HaSecretIo, fetchImpl: typeof fetch = fetch, now?: Date): Promise<number> {
  if (inFlight) {
    rerun = true;
    return inFlight;
  }
  const run = (async () => {
    // `inFlight` is cleared in the same step as the last `rerun` check (no await
    // between), so a request either joins a pass that will still look at it or
    // starts a drain of its own; none falls in between.
    try {
      let sent = 0;
      do {
        rerun = false;
        sent += await drainOnce(io, fetchImpl, now ?? new Date());
      } while (rerun);
      return sent;
    } finally {
      inFlight = null;
      rerun = false;
    }
  })();
  inFlight = run;
  return run;
}

async function drainOnce(io: HaSecretIo, fetchImpl: typeof fetch, now: Date): Promise<number> {
  const config = parseHomeAssistantConfig(await io.get(HA_CONFIG_SECRET_KEY));
  lastSeen = { setUp: !!config, at: now.getTime() };
  if (!config) return 0;
  const [raw, addonRaw] = await Promise.all([io.get(HA_OUTBOX_SECRET_KEY), io.get(HA_ADDON_QUEUE_SECRET_KEY)]);
  const main = parseHaOutbox(raw);
  const view = haPendingView(main, parseHaOutbox(addonRaw), now);
  if (view.pending.length === 0) return 0;

  const previous = main.status ?? null;
  const mode = haDrainMode(previous, config, view.pending, now);
  // Nothing is sent unless saving works right now: a save just before sending.
  // If saves are failing, this rejects and nothing goes out, so a failed save
  // after sending can repeat a pass's sends at most once, never every tick, and
  // a rejected token is not retried while its park cannot be saved.
  if (mode !== 'wait') {
    await withOutboxLock(async () => {
      const latest = parseHaOutbox(await io.get(HA_OUTBOX_SECRET_KEY));
      await io.set(HA_OUTBOX_SECRET_KEY, JSON.stringify({ ...latest, attemptAt: now.toISOString() }));
    });
  }
  // Waiting: only age out, and count, what is too old. Tests only: the untried
  // tests, never the alert that failed.
  const result = await drainHaOutbox(
    view,
    mode === 'wait' ? null : (entry) => sendHomeAssistantNotification(config, entry, fetchImpl),
    now,
    mode === 'tests' ? { only: (entry) => haUntriedTest(previous, entry) } : {},
  );
  // ONE write for what went out and the status. Re-read first: this companion's
  // own sync may have queued more while the sends ran. A failed re-read or write
  // rejects and writes nothing, so nothing queued meanwhile is lost; the next
  // pass sends this pass's alerts again, once (the save before sending stops it
  // from happening more). The add-on's key is never written here.
  const status = nextHaStatus(previous, result, config, now);
  await withOutboxLock(async () => {
    const latest = await io.get(HA_OUTBOX_SECRET_KEY);
    const json = JSON.stringify(mergeDrained(parseHaOutbox(latest), result.outbox, now, status));
    if (json !== latest) await io.set(HA_OUTBOX_SECRET_KEY, json);
  });
  return result.delivered;
}
