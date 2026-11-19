/**
 * The SimpleFin connection-problems record (#81): what the Bridge says is wrong
 * with a connection, kept between syncs so the add-on, Telegram, the daily
 * finding and Home Assistant all speak from one place, in one voice.
 *
 * Pure on purpose. It must not import telegram.ts or sync-core.ts (sync-core
 * imports this module).
 */
import { isSimplefinBridgeHost } from './simplefin-hosts.js';
import { isSimplefinNotice } from './simplefin-payload.js';
import type { SimplefinAccountSet } from './types.js';

/** The add-on secret that holds the record. */
export const SIMPLEFIN_PROBLEMS_SECRET_KEY = 'simplefin_problems';
/** A problem that is not a sign-in is shown once it has lasted this long. */
export const PROBLEM_SHOW_AFTER_MS = 24 * 60 * 60 * 1000;
/** The add-on ignores a record whose check is older than this. */
export const PROBLEM_RECORD_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const PROBLEM_MESSAGE_MAX_CHARS = 200;
const CONNECTION_NAME_MAX_CHARS = 80;

export type ConnectionProblemKind = 'signin' | 'other';

export interface ConnectionProblem {
  key: string;
  code: string;
  kind: ConnectionProblemKind;
  connectionName?: string;
  sfinAccountIds: string[];
  message: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ConnectionProblemsRecord {
  checkedAt: string;
  problems: ConnectionProblem[];
}

export type FoundConnectionProblem = Omit<ConnectionProblem, 'firstSeenAt' | 'lastSeenAt'>;

/** `con.auth` and `gen.auth` need the user to sign in; everything else is `other`. */
export function problemKind(code: string): ConnectionProblemKind {
  const c = code.toLowerCase();
  return c === 'con.auth' || c === 'gen.auth' ? 'signin' : 'other';
}

/** Plain text, one line, at most `max` characters (cut with an ellipsis). */
export function sanitizeProblemText(text: string, max = PROBLEM_MESSAGE_MAX_CHARS): string {
  const plain = String(text)
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(plain);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : plain;
}

/**
 * The problems worth keeping from one read. Window notices and `gen.api`
 * (a developer error) are dropped, and so is a problem whose known accounts are
 * all unmapped or ignored. One that names no account is kept.
 */
export function findConnectionProblems(
  set: SimplefinAccountSet,
  inUse: (sfinAccountId: string) => boolean,
): FoundConnectionProblem[] {
  const lines = set.errors ?? [];
  const list = set.errorList;
  const entries =
    list && list.length === lines.length
      ? list
      : lines.map((msg) => ({ code: 'legacy', msg: String(msg), connId: null, accountId: null, key: `legacy:${String(msg)}` }));
  const connNames = new Map((set.connections ?? []).map((c) => [c.connId, c.name]));
  const accounts = set.accounts ?? [];

  const found: FoundConnectionProblem[] = [];
  entries.forEach((entry, i) => {
    const line = String(lines[i] ?? entry.msg);
    if (isSimplefinNotice(line)) return;
    if (entry.code.toLowerCase().startsWith('gen.api')) return;

    const sfinAccountIds = entry.connId
      ? accounts.filter((a) => a?.conn_id === entry.connId).map((a) => a.id)
      : entry.accountId
        ? [entry.accountId]
        : [];
    if (sfinAccountIds.length > 0 && !sfinAccountIds.some(inUse)) return;

    const account = entry.accountId ? accounts.find((a) => a?.id === entry.accountId) : undefined;
    const rawName =
      (entry.connId ? connNames.get(entry.connId) : undefined) ??
      (account?.conn_id ? connNames.get(account.conn_id) : undefined) ??
      account?.org?.name;
    const connectionName = rawName ? sanitizeProblemText(rawName, CONNECTION_NAME_MAX_CHARS) : '';

    found.push({
      key: entry.key,
      code: entry.code,
      kind: problemKind(entry.code),
      ...(connectionName ? { connectionName } : {}),
      sfinAccountIds,
      message: sanitizeProblemText(line),
    });
  });
  return found;
}

/** The new record: firstSeenAt carried for a problem still reported, the rest dropped. */
export function mergeConnectionProblems(
  prev: ConnectionProblemsRecord | null,
  found: readonly FoundConnectionProblem[],
  now: Date,
): ConnectionProblemsRecord {
  const iso = now.toISOString();
  const before = new Map((prev?.problems ?? []).map((p) => [p.key, p]));
  return {
    checkedAt: iso,
    problems: found.map((p) => ({ ...p, firstSeenAt: before.get(p.key)?.firstSeenAt ?? iso, lastSeenAt: iso })),
  };
}

export function isConnectionProblem(p: unknown): p is ConnectionProblem {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.key === 'string' &&
    typeof o.code === 'string' &&
    (o.kind === 'signin' || o.kind === 'other') &&
    (o.connectionName === undefined || typeof o.connectionName === 'string') &&
    Array.isArray(o.sfinAccountIds) &&
    o.sfinAccountIds.every((id) => typeof id === 'string') &&
    typeof o.message === 'string' &&
    typeof o.firstSeenAt === 'string' &&
    !Number.isNaN(Date.parse(o.firstSeenAt)) &&
    typeof o.lastSeenAt === 'string'
  );
}

export function parseConnectionProblems(raw: string | null | undefined): ConnectionProblemsRecord | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.checkedAt !== 'string' || Number.isNaN(Date.parse(o.checkedAt)) || !Array.isArray(o.problems)) return null;
  return { checkedAt: o.checkedAt, problems: o.problems.filter(isConnectionProblem) };
}

/** What to tell the user: sign-ins at once, anything else once it has lasted 24 hours. */
export function shownConnectionProblems(
  record: ConnectionProblemsRecord | null,
  now: Date,
  opts: { maxRecordAgeMs?: number } = {},
): ConnectionProblem[] {
  if (!record) return [];
  if (opts.maxRecordAgeMs !== undefined && now.getTime() - Date.parse(record.checkedAt) > opts.maxRecordAgeMs) return [];
  return record.problems.filter(
    (p) => p.kind === 'signin' || now.getTime() - Date.parse(p.firstSeenAt) >= PROBLEM_SHOW_AFTER_MS,
  );
}

/** The Bridge's own site (no credentials, no path), or null for any other host. */
export function bridgeSiteOf(accessUrl: string | null | undefined): string | null {
  if (!accessUrl) return null;
  try {
    const url = new URL(accessUrl);
    return url.protocol === 'https:' && isSimplefinBridgeHost(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

export function connectionProblemTitle(p: ConnectionProblem): string {
  if (p.kind === 'signin') {
    return p.connectionName ? `${p.connectionName} needs you to sign in again` : 'SimpleFIN Bridge turned this sync away';
  }
  return `${p.connectionName ?? 'A SimpleFin connection'} isn't updating`;
}

export function connectionProblemText(p: ConnectionProblem): string {
  if (p.kind === 'signin') {
    return p.connectionName
      ? `${p.connectionName} needs you to sign in again at SimpleFIN Bridge. Until you do, its accounts show the last figures SimpleFin got, not today's.`
      : `SimpleFIN Bridge turned this sync away: ${sentence(p.message)} Until that's fixed, your accounts show the last figures SimpleFin got, not today's.`;
  }
  return `SimpleFin has reported this since ${dayOf(p.firstSeenAt)}: ${sentence(p.message)} Until it clears, the figures shown are the last ones SimpleFin got.`;
}

export function connectionProblemClearedText(p: ConnectionProblem): string {
  return p.connectionName
    ? `${p.connectionName} is updating again.`
    : `SimpleFin no longer reports: ${sentence(p.message)}`;
}
