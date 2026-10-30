/**
 * companion/src/status-server.ts
 *
 * The optional status page (#51): `GET /status` on `STATUS_PORT`, for someone
 * who runs the companion headless and wants to know whether the last sync
 * worked without opening Wealthfolio or reading container logs. It also serves
 * as a Docker healthcheck: 503 when the last run failed.
 *
 * The record lives in this process's memory, not in the `sync_health` secret,
 * because that secret is written THROUGH Wealthfolio, so a failed login, the
 * most likely headless failure, never reaches it. It covers the companion's own
 * runs (scheduled, startup, `/sync`), not a sync started in the add-on.
 *
 * Unauthenticated by design, so it is built to hold nothing worth stealing and
 * to do nothing but read: no amounts, names or access URL; the error text is
 * scrubbed before it is stored; a request never starts a sync, calls
 * Wealthfolio, or reads the database; only GET/HEAD on exactly `/status`; no
 * CORS header, so another site's page cannot read it from a browser. See
 * docs/superpowers/specs/2026-10-30-profile-id-and-status-design.md.
 */
import { createServer, type Server } from 'node:http';
import { INTERVAL_SKIP_MESSAGE, type SyncResult } from '../../shared/sync-core.js';

export type RunOutcome = 'synced' | 'limited' | 'too-soon' | 'not-configured' | 'failed';

export interface RunRecord {
  startedAt: string;
  finishedAt: string;
  outcome: RunOutcome;
  imported: number;
  skipped: number;
  /** The scrubbed failure message; `null` unless the run failed. */
  error: string | null;
}

export interface SyncStatus {
  running: boolean;
  lastRun: RunRecord | null;
  /** When the last `synced` run in this process finished. */
  lastSyncedAt: string | null;
}

/**
 * What a run that returned did. `notConfigured` is the companion's own early
 * return for a missing access URL, which carries no marker in its result; the
 * sync core's own not-configured returns say so in `errors`. Per-account notes
 * in `errors` do not make a run anything but `synced`, as in `sync_health`.
 */
export function outcomeOf(result: Pick<SyncResult, 'errors' | 'download'>, notConfigured: boolean): Exclude<RunOutcome, 'failed'> {
  if (notConfigured || result.errors.some((e) => e.startsWith('Not configured'))) return 'not-configured';
  if (result.download) return 'limited';
  if (result.errors.includes(INTERVAL_SKIP_MESSAGE)) return 'too-soon';
  return 'synced';
}

const MAX_ERROR_CHARS = 300;

/**
 * A failure message made safe for an unauthenticated page. The companion's
 * messages already avoid secrets (`httpError` never echoes a request body, and
 * the access URL is masked in logs), so this is the backstop for one that
 * slips through: URL credentials, bearer/basic tokens and JWT-shaped strings
 * are masked, control characters and newlines collapse to spaces, and the
 * result is capped.
 */
export function scrubStatusError(message: string): string {
  const scrubbed = message
    .replace(/\/\/[^\s/@]+@/g, '//***@')
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 ***')
    .replace(/\beyJ[\w-]*\.[\w-]*\.[\w-]*/g, '***')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...scrubbed].slice(0, MAX_ERROR_CHARS).join('');
}

export interface SyncStatusRecorder {
  /** Marks a run started; the handle records how it ended, once. */
  begin(): {
    finish(outcome: Exclude<RunOutcome, 'failed'>, counts: { imported: number; skipped: number }): void;
    fail(message: string): void;
  };
  /** A copy of the record: the server serializes it, nobody edits it. */
  snapshot(): SyncStatus;
}

export function createSyncStatus(now: () => Date = () => new Date()): SyncStatusRecorder {
  // A count, not a flag: runs are serialized by `runCompanionSyncExclusive`,
  // but nothing here should depend on that to stay truthful.
  let running = 0;
  let lastRun: RunRecord | null = null;
  let lastSyncedAt: string | null = null;
  return {
    begin() {
      const startedAt = now().toISOString();
      running += 1;
      let done = false;
      const settle = (record: Omit<RunRecord, 'startedAt' | 'finishedAt'>) => {
        if (done) return;
        done = true;
        running = Math.max(0, running - 1);
        lastRun = { startedAt, finishedAt: now().toISOString(), ...record };
        if (record.outcome === 'synced') lastSyncedAt = lastRun.finishedAt;
      };
      return {
        finish: (outcome, counts) => settle({ outcome, imported: counts.imported, skipped: counts.skipped, error: null }),
        fail: (message) => settle({ outcome: 'failed', imported: 0, skipped: 0, error: scrubStatusError(message) }),
      };
    },
    snapshot: () => ({ running: running > 0, lastRun: lastRun ? { ...lastRun } : null, lastSyncedAt }),
  };
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

/**
 * The whole HTTP surface, as a pure function: exactly `/status` (a query string
 * is ignored), GET or HEAD. Nothing from the request is reflected back.
 */
export function statusReply(
  method: string | undefined,
  url: string | undefined,
  version: string,
  status: SyncStatus,
): { status: number; headers: Record<string, string>; body: string } {
  if ((url ?? '').split('?')[0] !== '/status') {
    return { status: 404, headers: { ...JSON_HEADERS }, body: '{"error":"not found"}' };
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, headers: { ...JSON_HEADERS, Allow: 'GET, HEAD' }, body: '{"error":"method not allowed"}' };
  }
  const ok = status.lastRun?.outcome !== 'failed';
  return {
    status: ok ? 200 : 503,
    headers: { ...JSON_HEADERS },
    body: JSON.stringify({ version, ok, running: status.running, lastRun: status.lastRun, lastSyncedAt: status.lastSyncedAt }),
  };
}

/**
 * `STATUS_PORT` (and optional `STATUS_HOST`, the bind address) from the
 * environment: `null` when unset, a warning when it is not a port or collides
 * with the mini app's. A warning leaves the page off; it never stops the daemon.
 */
export function statusServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): { port: number; host?: string } | { warning: string } | null {
  const raw = (env.STATUS_PORT ?? '').trim();
  if (!raw) return null;
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    return { warning: `STATUS_PORT must be a port number from 1 to 65535; the status page is off.` };
  }
  if ((env.MINIAPP_PORT ?? '').trim() === raw) {
    return { warning: `STATUS_PORT is the same as MINIAPP_PORT; give the status page its own port. The status page is off.` };
  }
  const host = (env.STATUS_HOST ?? '').trim();
  return host ? { port, host } : { port };
}

/**
 * Serves `statusReply` over the latest `read()`. The request body is never
 * read (only drained), the timeouts are short, and a bind failure, such as a
 * port already in use, is logged instead of crashing the daemon.
 */
export function startStatusServer(opts: {
  port: number;
  host?: string;
  version: string;
  read: () => SyncStatus;
  log: (message: string) => void;
}): Server {
  const server = createServer((req, res) => {
    req.resume();
    const out = statusReply(req.method, req.url, opts.version, opts.read());
    res.writeHead(out.status, out.headers);
    res.end(req.method === 'HEAD' ? undefined : out.body);
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  const where = `${opts.host ?? 'all interfaces'}, port ${opts.port}`;
  server.on('error', (err) => opts.log(`Status page could not start on ${where}: ${err.message}`));
  server.listen(opts.port, opts.host, () => opts.log(`Status page listening on ${where} (GET /status)`));
  return server;
}
