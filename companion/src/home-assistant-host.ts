/**
 * companion/src/home-assistant-host.ts
 *
 * The companion's half of Home Assistant alerts (shared/home-assistant.ts):
 * queueing this run's alerts, and draining what both writers queued. Only the
 * companion sends, because only it can reach a Home Assistant address.
 */
import {
  drainHaOutbox, HA_ADDON_QUEUE_SECRET_KEY, HA_CONFIG_SECRET_KEY, HA_OUTBOX_SECRET_KEY,
  haDrainMode, haIsTest, haPendingView, mergeDrained, nextHaStatus, parseHaOutbox, parseHomeAssistantConfig,
  queueHaEntries, sendHomeAssistantNotification, syncAlertEntries, syncHealthEntry, type HaEntry, type HaSecretIo,
} from '../../shared/home-assistant.js';
import type { SyncResult } from '../../shared/sync-core.js';

const ADDON_ID = 'simplefin-sync';

/** Whether a Wealthfolio REST error is a refused session (HTTP 401 or 403):
 *  the client's errors carry the response's `status`. */
export function isWealthfolioAuthError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
}

/**
 * The secret reads and writes the shared module needs, over REST. With
 * `signIn`, a read or write refused for an expired session (401/403 only, never
 * a 500 or an unreachable server) signs in once and is tried again, so a pass
 * whose session expires midway carries on. If signing in fails, the original
 * error is the one reported. `signIn` decides how often it may run.
 */
export function haSecretIo(
  client: {
    getAddonSecret(addonId: string, key: string): Promise<string | null>;
    setAddonSecret(addonId: string, key: string, value: string): Promise<void>;
  },
  signIn?: () => Promise<unknown>,
): HaSecretIo {
  const retrying = async <T>(op: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch (err) {
      if (!signIn || !isWealthfolioAuthError(err)) throw err;
      try { await signIn(); } catch { throw err; }
      return op();
    }
  };
  return {
    get: (key) => retrying(() => client.getAddonSecret(ADDON_ID, key)),
    set: (key, value) => retrying(() => client.setAddonSecret(ADDON_ID, key, value)),
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
 *  instead of every tick. Also the most often a client signs in again after an
 *  expired session (`haMaySignIn`), set up or not. */
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

/**
 * After a read or write was refused for an expired session: whether a client
 * may sign in again now. At most once per `HA_IDLE_RECHECK_MS`, set up or not:
 * a session that expired after a quiet spell signs in at once (the last sign-in
 * is long past), but a wrong password can't cause a failed login every tick.
 * `lastSignInAt` 0 lets the first one through.
 */
export function haMaySignIn(lastSignInAt: number, now = Date.now()): boolean {
  return now - lastSignInAt >= HA_IDLE_RECHECK_MS;
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
 * when a secret cannot be read or written (for an expired session, after `io`
 * signed in again if its limit allowed); the next pass retries. One drain at a time: the after-sync drain and the 5-minute one would
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
  // Ids an earlier pass was sending when its last save failed: they may have
  // arrived, so they are marked sent and never sent again.
  const unconfirmed = new Set(main.sending ?? []);
  // Each alert's id is saved just before it is sent. If that save fails, the
  // pass stops and the alert is not sent: while saves fail nothing goes out, so
  // nothing repeats and a rejected token is not retried.
  const send = async (entry: HaEntry) => {
    await withOutboxLock(async () => {
      const latest = parseHaOutbox(await io.get(HA_OUTBOX_SECRET_KEY));
      await io.set(HA_OUTBOX_SECRET_KEY, JSON.stringify({ ...latest, sending: [...(latest.sending ?? []), entry.id] }));
    });
    return sendHomeAssistantNotification(config, entry, fetchImpl);
  };
  // Waiting: only age out, and count, what is too old. Tests only: the queued
  // tests, never the alert that failed.
  const result = await drainHaOutbox(view, mode === 'wait' ? null : send, now, {
    unconfirmed: (id) => unconfirmed.has(id),
    ...(mode === 'tests' ? { only: haIsTest } : {}),
  });
  // ONE write for what went out and the status, which also clears `sending`.
  // Re-read first: this companion's own sync may have queued more while the
  // sends ran. A failed re-read or write rejects and writes nothing, so nothing
  // queued meanwhile is lost; the next pass treats what this one was sending as
  // sent. The add-on's key is never written here.
  const status = nextHaStatus(previous, result, config, now);
  // If this save fails even after `io` signed in again, the `sending` ids make
  // the next pass treat those alerts as sent.
  await withOutboxLock(async () => {
    const latest = await io.get(HA_OUTBOX_SECRET_KEY);
    const json = JSON.stringify(mergeDrained(parseHaOutbox(latest), result.outbox, now, status));
    if (json !== latest) await io.set(HA_OUTBOX_SECRET_KEY, json);
  });
  // Stopped early (a save before a send failed): what it did is recorded above,
  // so nothing delivered is later reported as "may not have arrived".
  if (result.aborted) throw result.aborted;
  return result.delivered;
}
