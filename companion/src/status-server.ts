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
 * A failure message made safe for an unauthenticated page. The log keeps the
 * full text; the page gets the reason without anything private:
 * - the known secrets (the Wealthfolio password and API key), literally;
 * - URL credentials, up to the authority's LAST `@`, spaces included: Node's
 *   fetch quotes a caller's raw URL, which need not be encoded;
 * - a Telegram bot token, bearer/basic tokens and JWT-shaped strings;
 * - text a server sent: `httpError`'s ` - <response body>`, and the snippet of
 *   the input a JSON parse error quotes (amounts, payees);
 * - control characters; the rest is capped.
 */
export function scrubStatusError(message: string, secrets: readonly string[] = []): string {
  let text = message;
  for (const secret of secrets) {
    if (secret.length >= 4) text = text.split(secret).join('***');
  }
  const scrubbed = text
    .replace(/\/\/[^/?#]*@/g, '//***@')
    .replace(/\bbot\d+:[\w-]+/g, 'bot***')
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 ***')
    .replace(/\beyJ[\w-]*\.[\w-]*\.[\w-]*/g, '***')
    .replace(/(failed: \d{3}|\(HTTP 423\)) - [\s\S]*$/, '$1')
    .replace(/(Unexpected token .{1,8}, )?"[\s\S]*?"(\.\.\.)? is not valid JSON/g, 'a reply that is not valid JSON')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
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

export function createSyncStatus(
  now: () => Date = () => new Date(),
  /** Values the page must never show, read when a run fails. */
  secrets: () => readonly string[] = () => [],
): SyncStatusRecorder {
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
        fail: (message) => settle({ outcome: 'failed', imported: 0, skipped: 0, error: scrubStatusError(message, secrets()) }),
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
  const server = createServer(
    // Node enforces these two only on each `connectionsCheckingInterval` tick
    // (30 s by default), so the tick is shortened too.
    { headersTimeout: 5_000, requestTimeout: 10_000, connectionsCheckingInterval: 1_000, maxHeaderSize: 8_192 },
    (req, res) => {
      req.resume();
      const out = statusReply(req.method, req.url, opts.version, opts.read());
      res.writeHead(out.status, out.headers);
      res.end(req.method === 'HEAD' ? undefined : out.body);
    },
  );
  server.keepAliveTimeout = 5_000;
  // A flood of connections must not crowd out the sync on one event loop.
  server.maxConnections = 64;
  server.setTimeout(10_000, (socket) => socket.destroy());
  const where = `${opts.host ?? 'all interfaces'}, port ${opts.port}`;
  server.on('error', (err) => opts.log(`Status page could not start on ${where}: ${err.message}`));
  server.listen(opts.port, opts.host, () => opts.log(`Status page listening on ${where} (GET /status)`));
  return server;
}
