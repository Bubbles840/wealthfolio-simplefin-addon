/**
 * How often SimpleFin may be asked for data, and the one place that decides it.
 *
 * WHY THIS EXISTS. Nothing used to limit downloads: the scheduled sync, the
 * Sync button, "Sync anyway" and the Telegram `/sync` command each called
 * SimpleFin whenever asked, and "Sync anyway" and `/sync` bypassed the
 * one-hour wall entirely. SimpleFin Bridge expects about 24 requests a day per
 * access token; past that it warns and then DISABLES the token, which cuts off
 * every bank at once and needs a new Setup Token to undo
 * (https://beta-bridge.simplefin.org/info/developers).
 *
 * THE RULES.
 *  - C2/R8: at most 20 downloads in any rolling 24 hours (a safety margin under
 *    the ~24 Bridge expects), and at least 5 minutes between two of them. A
 *    FAILED attempt counts too: SimpleFin counts attempts, not successes.
 *  - C5/R17: every SimpleFin caller counts, including backfill, which obeys the
 *    20. Only Setup and Refresh accounts (`setup`) may use the headroom up to
 *    24, and they ignore the gap, because a person is waiting on them.
 *  - C3/R18: a MANUAL Sync inside the 5-minute gap downloads nothing and only
 *    re-checks balances; a scheduled or automatic call inside it just waits.
 *  - C1: one record, shared by both writers (the browser add-on and the Node
 *    companion), kept in the add-on's secrets. Read-check-write is NOT atomic;
 *    recording the request BEFORE it is sent narrows the race to one round
 *    trip, and the 20-under-24 margin absorbs a rare collision.
 *    The budget FAILS CLOSED: a record that cannot be read or written means
 *    nothing is downloaded, and a corrupt record is reset to empty so that
 *    only the current call is blocked.
 *
 * Imports nothing from the project: it runs unchanged in both writers.
 */

export const SIMPLEFIN_REQUESTS_SECRET_KEY = 'simplefin_requests';
export const SIMPLEFIN_DAILY_LIMIT = 20;
export const SIMPLEFIN_SETUP_CEILING = 24;
export const SIMPLEFIN_GAP_MS = 5 * 60_000;
export const SIMPLEFIN_WINDOW_MS = 24 * 60 * 60_000;
/** The 5-minute gap ignores a stamp more than this far ahead of `now`. A writer
 *  with a badly wrong clock could otherwise stamp hours ahead; the gap measured
 *  from that stamp stays negative, so every run on both writers would wait or
 *  check only until the clock caught up, and Reset deliberately keeps the
 *  record, so nothing could clear it. The daily COUNT still includes such a
 *  stamp: never under-count real requests (token safety first). */
export const SIMPLEFIN_FUTURE_TOLERANCE_MS = 60 * 60_000;

export type SimplefinPurpose = 'manual' | 'scheduled' | 'auto' | 'setup';

export type SimplefinGate =
  | { kind: 'go'; at: Date }
  | { kind: 'checkOnly'; lastAt: Date }
  | { kind: 'wait'; lastAt: Date }
  | { kind: 'budget'; nextAt: Date }
  | { kind: 'unreadable' };

export interface RequestLogIo {
  read(): Promise<string | null>;
  write(raw: string): Promise<void>;
}

/** The stored record as epoch ms, newest first. Absent or empty is `[]`;
 *  anything but an array of parseable time strings is corrupt (null). */
export function parseRequestLog(raw: string | null | undefined): number[] | null {
  if (raw === null || raw === undefined || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const times: number[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') return null;
    const ms = Date.parse(item);
    if (!Number.isFinite(ms)) return null;
    times.push(ms);
  }
  return times.sort((a, b) => b - a);
}

/** Every request newer than 24 hours before `now`, newest first. A request
 *  stamped slightly AHEAD of `now` (the other writer's clock) still counts. */
export function requestsInWindow(log: number[], now: Date): number[] {
  const floor = now.getTime() - SIMPLEFIN_WINDOW_MS;
  return log.filter((t) => t > floor).sort((a, b) => b - a);
}

export function decideSimplefinRequest(log: number[], purpose: SimplefinPurpose, now: Date): SimplefinGate {
  const limit = purpose === 'setup' ? SIMPLEFIN_SETUP_CEILING : SIMPLEFIN_DAILY_LIMIT;
  const window = requestsInWindow(log, now);
  if (window.length >= limit) {
    const oldestFirst = [...window].reverse();
    return { kind: 'budget', nextAt: new Date(oldestFirst[window.length - limit] + SIMPLEFIN_WINDOW_MS) };
  }
  const newest = window.find((t) => t - now.getTime() <= SIMPLEFIN_FUTURE_TOLERANCE_MS);
  if (purpose !== 'setup' && newest !== undefined && now.getTime() - newest < SIMPLEFIN_GAP_MS) {
    const lastAt = new Date(newest);
    return purpose === 'manual' ? { kind: 'checkOnly', lastAt } : { kind: 'wait', lastAt };
  }
  return { kind: 'go', at: now };
}

/** Decide AND record: on `go` the request is written before this returns, so the
 *  caller sends it only once it is counted. Every failure to read or write is
 *  `unreadable` (fail closed). */
export async function reserveSimplefinRequest(io: RequestLogIo, purpose: SimplefinPurpose, now: Date): Promise<SimplefinGate> {
  let raw: string | null;
  try {
    raw = await io.read();
  } catch {
    return { kind: 'unreadable' };
  }
  const log = parseRequestLog(raw);
  if (log === null) {
    // Reset, so one corrupt record blocks only this call, not every call after.
    try { await io.write('[]'); } catch { /* still unreadable this time */ }
    return { kind: 'unreadable' };
  }
  const gate = decideSimplefinRequest(log, purpose, now);
  if (gate.kind !== 'go') return gate;
  try {
    await io.write(JSON.stringify([now.getTime(), ...requestsInWindow(log, now)].map((t) => new Date(t).toISOString())));
  } catch {
    return { kind: 'unreadable' };
  }
  return gate;
}

/** "3:10 PM" — local time, 12-hour. */
export function clockTime(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const minutesAgo = (ms: number, now: Date) => Math.max(1, Math.round((now.getTime() - ms) / 60_000));

/** The one line for a gate that downloaded nothing; null for `go`. */
export function gateLine(gate: SimplefinGate, now: Date): string | null {
  switch (gate.kind) {
    case 'budget': return `SimpleFin's daily limit is used up — next sync at ${clockTime(gate.nextAt)}.`;
    case 'unreadable': return "Couldn't read the SimpleFin request log — nothing was downloaded.";
    case 'wait': return `SimpleFin was asked ${minutesAgo(gate.lastAt.getTime(), now)} min ago — this scheduled sync was skipped.`;
    case 'checkOnly': return checkedLine(gate.lastAt.getTime(), now);
    default: return null;
  }
}

/** What a check-only pass reports. `dataAt` null: no account was compared
 *  (none fresh, uncomparable, or the stored figures could not be read). */
export function checkedLine(dataAt: number | null, now: Date): string {
  if (dataAt === null) return 'Balances not checked this time — the next download will check them.';
  return `Balances checked · bank data is from ${minutesAgo(dataAt, now)} min ago.`;
}

/** Requests in the last 24 hours, or null when the record is corrupt. */
export function requestsToday(raw: string | null, now: Date): number | null {
  const log = parseRequestLog(raw);
  return log === null ? null : requestsInWindow(log, now).length;
}

export function budgetStatusLine(count: number): string {
  return `SimpleFin: ${count} of ${SIMPLEFIN_DAILY_LIMIT} today`;
}

/** The record as an I/O pair, or null for a store that keeps none (both methods or neither). */
export function requestLogIo(store: {
  getSimplefinRequests?(): Promise<string | null>;
  setSimplefinRequests?(raw: string): Promise<void>;
}): RequestLogIo | null {
  const get = store.getSimplefinRequests;
  const set = store.setSimplefinRequests;
  if (!get || !set) return null;
  return { read: () => get.call(store), write: (raw) => set.call(store, raw) };
}

/**
 * The gate for a SimpleFin call made OUTSIDE a sync (C5, R17). Three callers,
 * three purposes, one record:
 *  - Setup's claim-and-first-fetch and Settings' "Refresh from SimpleFin"
 *    (purpose 'setup'): a person is waiting on them, so they may use the
 *    headroom up to the Setup ceiling of 24 and ignore the 5-minute gap.
 *  - the automatic account-name backfill on page load (purpose 'auto'): cosmetic
 *    and nobody asked for it, so it obeys the 20 and the gap like a scheduled run
 *    and its caller just skips when refused.
 * Returns null when the call may go ahead (the request is now recorded) or the
 * store keeps no record (an older host: nothing to count); otherwise the one
 * line saying why nothing may be downloaded.
 */
export async function directCallLine(
  store: Parameters<typeof requestLogIo>[0],
  purpose: 'setup' | 'auto',
  now = new Date(),
): Promise<string | null> {
  const io = requestLogIo(store);
  if (!io) return null;
  const gate = await reserveSimplefinRequest(io, purpose, now);
  return gateLine(gate, now);
}
