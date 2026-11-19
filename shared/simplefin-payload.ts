/**
 * shared/simplefin-payload.ts
 *
 * The one place a raw SimpleFin `/accounts` body becomes a `SimplefinAccountSet`.
 *
 * Both halves used to do `JSON.parse(body) as SimplefinAccountSet` — a cast, not
 * a parse, which bought two problems:
 *
 *  1. `errors` was trusted to exist. Downstream reads it with a bare `for…of`,
 *     so a Bridge that sent only the newer `errlist` (or neither field) would
 *     throw a TypeError in the middle of a sync rather than report no errors.
 *  2. The newer `errlist` was ignored entirely. It carries a code, a connection
 *     id and an account id per failure, where `errors` is prose. That difference
 *     is not cosmetic: when Discover's feed died it published nothing for weeks,
 *     and the only signal was an untethered sentence — nothing said WHICH
 *     connection had stopped. Resolving `account_id` against the accounts in the
 *     same payload turns that into "Discover it Card: …".
 *
 * `errors` keeps its meaning — human-readable strings, one per distinct failure
 * — so every existing consumer is untouched; `errorList` carries the structure
 * for anything that wants to act per connection.
 */
import type { SimplefinAccount, SimplefinAccountSet, SimplefinBridgeError, SimplefinConnection } from './types.js';

function text(value: unknown, fallback = ''): string {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function optional(value: unknown): string | null {
  const s = text(value);
  return s === '' ? null : s;
}

/**
 * Parses a SimpleFin `/accounts` payload.
 *
 * Throws only for a body that is not an object at all — a transport or auth
 * failure wearing a 200, which is worth failing loudly. Everything inside is
 * read defensively: a missing `accounts` array reads as no accounts, since a
 * Bridge mid-outage legitimately returns errors and nothing else.
 */
export function normalizeAccountSet(payload: unknown): SimplefinAccountSet {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('SimpleFin returned a payload that is not an object');
  }
  const raw = payload as Record<string, unknown>;
  const connections: SimplefinConnection[] = [];
  const orgByConn = new Map<string, NonNullable<SimplefinAccount['org']>>();
  if (Array.isArray(raw.connections)) {
    for (const item of raw.connections) {
      const c = (item ?? {}) as Record<string, unknown>;
      const connId = optional(c.conn_id);
      if (!connId) continue;
      connections.push({ connId, name: text(c.name) });
      orgByConn.set(connId, orgOf(c));
    }
  }
  // v2 sends no `org` on an account, only the `conn_id` of its connection;
  // give it the org v1 would have, so nothing downstream needs to know.
  const accounts = ((Array.isArray(raw.accounts) ? raw.accounts : []) as SimplefinAccount[]).map((a) => {
    const org = a && !a.org && a.conn_id ? orgByConn.get(a.conn_id) : undefined;
    return org ? { ...a, org } : a;
  });
  const connNameById = new Map(connections.map((c) => [c.connId, c.name]));
  const nameById = new Map(accounts.map((a) => [text(a?.id), text(a?.name)]));

  const errorList: SimplefinBridgeError[] = [];
  const seen = new Set<string>();
  const push = (entry: SimplefinBridgeError) => {
    // A broken institution reports once per affected account, so one dead
    // connection arrives as several identical entries. The Sync page, and any
    // alert built on this, should say it once.
    if (seen.has(entry.key)) return;
    seen.add(entry.key);
    errorList.push(entry);
  };

  if (Array.isArray(raw.errlist) && raw.errlist.length > 0) {
    for (const item of raw.errlist) {
      const e = (item ?? {}) as Record<string, unknown>;
      const code = text(e.code, 'unknown');
      const msg = text(e.msg);
      const connId = optional(e.conn_id);
      const accountId = optional(e.account_id);
      push({
        code,
        msg,
        connId,
        accountId,
        // conn_id is the durable handle for "this institution connection"; the
        // account id is the next best, and the message itself is the last
        // resort for an entry carrying neither.
        key: `${code}:${connId ?? accountId ?? msg}`,
      });
    }
  } else if (Array.isArray(raw.errors)) {
    for (const msg of raw.errors) {
      push({ code: 'legacy', msg: String(msg), connId: null, accountId: null, key: `legacy:${String(msg)}` });
    }
  }

  return {
    accounts,
    errors: errorList.map(describeBridgeError(nameById, connNameById)),
    errorList,
    ...(connections.length > 0 ? { connections } : {}),
  };
}

/**
 * The org v1 gave an account, rebuilt from its v2 connection. `org.name` is the
 * connection's `name` (checked against the live demo, which sends "SimpleFIN
 * Demo" for both), NOT `org_name` ("SimpleFIN Bridge").
 */
function orgOf(c: Record<string, unknown>): NonNullable<SimplefinAccount['org']> {
  const org: NonNullable<SimplefinAccount['org']> = {};
  const name = text(c.name);
  if (name) org.name = name;
  const orgUrl = text(c.org_url);
  try {
    org.domain = new URL(orgUrl).hostname;
    org.url = orgUrl;
  } catch {
    // not a URL: neither field
  }
  const sfinUrl = text(c.sfin_url);
  if (sfinUrl) org['sfin-url'] = sfinUrl;
  return org;
}

/**
 * One failure as a line a human can act on.
 *
 * The name is what makes the message useful, so it is preferred over every id;
 * an account the payload no longer carries (exactly what a dead connection looks
 * like) falls back to its id, and a connection-scoped failure to the conn id. A
 * legacy string is already prose and is passed through unchanged rather than
 * decorated with a meaningless `(account null)`.
 */
function describeBridgeError(nameById: Map<string, string>, connNameById: Map<string, string>) {
  return (error: SimplefinBridgeError): string => {
    const name = error.accountId ? nameById.get(error.accountId) : undefined;
    if (name) return `${name}: ${error.msg}`;
    const connName = error.connId ? connNameById.get(error.connId) : undefined;
    if (connName) return `${connName}: ${error.msg}`;
    if (error.accountId) return `${error.msg} (account ${error.accountId})`;
    if (error.connId) return `${error.msg} (connection ${error.connId})`;
    return error.msg;
  };
}

/**
 * SimpleFin returns informational notices (window-size recommendations and
 * caps) in the same `errors` array as real failures. A wide re-scan always trips
 * them and the data still comes back, so they are not failures: the sync drops
 * them, and nothing that asks "did this read fail?" should count them.
 */
export function isSimplefinNotice(error: unknown): boolean {
  return /\b(exceeds|recommended|was capped|date range|will be capped|may be capped)\b/i.test(String(error));
}
