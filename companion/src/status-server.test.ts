import { describe, it, expect, afterEach } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { INTERVAL_SKIP_MESSAGE } from '../../shared/sync-core.js';
import {
  createSyncStatus, outcomeOf, scrubStatusError, startStatusServer, statusReply, statusServerConfig,
  type SyncStatus,
} from './status-server';

const T0 = new Date('2027-03-04T10:00:00.000Z');
const T1 = new Date('2027-03-04T10:01:30.000Z');

function clock(...times: Date[]) {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
}

const counts = { imported: 3, skipped: 120 };

describe('outcomeOf', () => {
  const base = { errors: [] as string[] };
  it('reads a plain run as synced, per-account notes included', () => {
    expect(outcomeOf(base, false)).toBe('synced');
    expect(outcomeOf({ errors: ['Chase: balance unavailable'] }, false)).toBe('synced');
  });
  it('reads the SimpleFin budget stopping the download as limited', () => {
    expect(outcomeOf({ ...base, download: { kind: 'checkOnly', line: 'x' } }, false)).toBe('limited');
    expect(outcomeOf({ ...base, download: { kind: 'skipped', line: 'x' } }, false)).toBe('limited');
  });
  it('reads the one-hour minimum interval as too-soon', () => {
    expect(outcomeOf({ errors: [INTERVAL_SKIP_MESSAGE] }, false)).toBe('too-soon');
  });
  it('reads a missing access URL or mapping as not-configured', () => {
    expect(outcomeOf(base, true)).toBe('not-configured');
    expect(outcomeOf({ errors: ['Not configured: no account mapping'] }, false)).toBe('not-configured');
  });
});

describe('createSyncStatus', () => {
  it('starts with no run, nothing running', () => {
    expect(createSyncStatus(clock(T0)).snapshot()).toEqual({ running: false, lastRun: null, lastSyncedAt: null });
  });

  it('records a synced run with its counts and times, and marks it running meanwhile', () => {
    const status = createSyncStatus(clock(T0, T1));
    const run = status.begin();
    expect(status.snapshot().running).toBe(true);
    run.finish('synced', counts);
    expect(status.snapshot()).toEqual({
      running: false,
      lastRun: { startedAt: T0.toISOString(), finishedAt: T1.toISOString(), outcome: 'synced', imported: 3, skipped: 120, error: null },
      lastSyncedAt: T1.toISOString(),
    });
  });

  it('records a failure with a scrubbed message and keeps the last synced time', () => {
    const status = createSyncStatus(clock(T0, T0, T1, T1));
    status.begin().finish('synced', counts);
    status.begin().fail('SimpleFin fetch https://user:secret@bridge.simplefin.org/simplefin/accounts failed');
    const snap = status.snapshot();
    expect(snap.lastRun).toMatchObject({ outcome: 'failed', imported: 0, skipped: 0 });
    expect(snap.lastRun!.error).toBe('SimpleFin fetch https://***@bridge.simplefin.org/simplefin/accounts failed');
    expect(snap.lastSyncedAt).toBe(T0.toISOString());
  });

  it('only a synced run moves lastSyncedAt', () => {
    const status = createSyncStatus(clock(T0, T1));
    status.begin().finish('too-soon', { imported: 0, skipped: 0 });
    expect(status.snapshot().lastSyncedAt).toBeNull();
  });

  it('a run finished twice counts once, and running never goes negative', () => {
    const status = createSyncStatus(clock(T0, T1));
    const run = status.begin();
    run.finish('synced', counts);
    run.fail('late');
    expect(status.snapshot().lastRun!.outcome).toBe('synced');
    expect(status.snapshot().running).toBe(false);
  });

  it('hands out copies, so a caller cannot edit the record', () => {
    const status = createSyncStatus(clock(T0, T1));
    status.begin().finish('synced', counts);
    status.snapshot().lastRun!.imported = 999;
    expect(status.snapshot().lastRun!.imported).toBe(3);
  });
});

describe('scrubStatusError', () => {
  it('masks URL credentials, bearer and basic tokens, and JWTs', () => {
    expect(scrubStatusError('GET https://a1b2:c3d4@beta-bridge.simplefin.org/x')).toBe('GET https://***@beta-bridge.simplefin.org/x');
    expect(scrubStatusError('header Authorization: Bearer abc.def-ghi rejected')).toBe('header Authorization: Bearer *** rejected');
    expect(scrubStatusError('header Basic dXNlcjpwYXNz rejected')).toBe('header Basic *** rejected');
    expect(scrubStatusError('cookie wf_session=eyJhbGciOiJIUzI1NiJ9.eyJzaWQiOiJ4In0.sig_nature-1; Path=/')).toBe('cookie wf_session=***; Path=/');
  });

  it('collapses control characters and newlines into one line', () => {
    expect(scrubStatusError('first\nsecond\r\n\tthird\u0007')).toBe('first second third');
  });

  it('caps the message at 300 characters', () => {
    expect(scrubStatusError('x'.repeat(1000))).toHaveLength(300);
  });
});

describe('statusReply', () => {
  const idle: SyncStatus = { running: false, lastRun: null, lastSyncedAt: null };
  const failed: SyncStatus = {
    running: false, lastSyncedAt: null,
    lastRun: { startedAt: T0.toISOString(), finishedAt: T1.toISOString(), outcome: 'failed', imported: 0, skipped: 0, error: 'Wealthfolio login failed: 401' },
  };

  it('answers GET /status with 200 and the record before any run', () => {
    const out = statusReply('GET', '/status', '1.71.0', idle);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ version: '1.71.0', ok: true, running: false, lastRun: null, lastSyncedAt: null });
  });

  it('answers 503 when the last run failed, with the message', () => {
    const out = statusReply('GET', '/status', '1.71.0', failed);
    expect(out.status).toBe(503);
    expect(JSON.parse(out.body)).toMatchObject({ ok: false, lastRun: { outcome: 'failed', error: 'Wealthfolio login failed: 401' } });
  });

  it('ignores a query string, and answers HEAD like GET', () => {
    expect(statusReply('GET', '/status?x=1', 'v', idle).status).toBe(200);
    expect(statusReply('HEAD', '/status', 'v', failed).status).toBe(503);
  });

  it('sends JSON that is never cached or sniffed, and no CORS header', () => {
    const { headers } = statusReply('GET', '/status', 'v', idle);
    expect(headers).toEqual({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  it('refuses every other method with 405 and Allow, and every other path with 404, echoing nothing', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const out = statusReply(method, '/status', 'v', idle);
      expect(out.status).toBe(405);
      expect(out.headers.Allow).toBe('GET, HEAD');
    }
    for (const path of ['/', '/status/', '/statusx', '//status', '/<script>', '/status/../status', undefined]) {
      const out = statusReply('GET', path, 'v', idle);
      expect(out.status).toBe(404);
      expect(out.body).not.toContain('script');
    }
  });
});

describe('statusServerConfig', () => {
  it('is off without STATUS_PORT', () => {
    expect(statusServerConfig({})).toBeNull();
    expect(statusServerConfig({ STATUS_PORT: '  ' })).toBeNull();
  });

  it('reads a port and an optional bind address', () => {
    expect(statusServerConfig({ STATUS_PORT: '8099' })).toEqual({ port: 8099 });
    expect(statusServerConfig({ STATUS_PORT: ' 8099 ', STATUS_HOST: '127.0.0.1' })).toEqual({ port: 8099, host: '127.0.0.1' });
  });

  it('refuses a value that is not a port, and the mini app port', () => {
    for (const bad of ['0', '65536', '80a', '-1', '1e3', '8099.5']) {
      expect(statusServerConfig({ STATUS_PORT: bad })).toEqual({ warning: expect.stringContaining('STATUS_PORT') });
    }
    expect(statusServerConfig({ STATUS_PORT: '8090', MINIAPP_PORT: '8090' })).toEqual({ warning: expect.stringContaining('MINIAPP_PORT') });
  });
});

describe('startStatusServer', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server?.listening) await new Promise((r) => server!.close(r));
    server = null;
  });

  async function listen(read: () => SyncStatus, log: (m: string) => void = () => {}) {
    server = startStatusServer({ port: 0, host: '127.0.0.1', version: '1.71.0', read, log });
    await once(server, 'listening');
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('serves the live record over HTTP and nothing else', async () => {
    let status: SyncStatus = { running: false, lastRun: null, lastSyncedAt: null };
    const base = await listen(() => status);
    const first = await fetch(`${base}/status`);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(first.headers.get('access-control-allow-origin')).toBeNull();
    expect(await first.json()).toMatchObject({ ok: true, version: '1.71.0' });

    status = { ...status, lastRun: { startedAt: 'a', finishedAt: 'b', outcome: 'failed', imported: 0, skipped: 0, error: 'boom' } };
    expect((await fetch(`${base}/status`)).status).toBe(503);
    expect((await fetch(`${base}/status`, { method: 'POST', body: 'x'.repeat(100_000) })).status).toBe(405);
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });

  it('sends no body to HEAD', async () => {
    const base = await listen(() => ({ running: false, lastRun: null, lastSyncedAt: null }));
    const res = await fetch(`${base}/status`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('logs a port that is already taken instead of crashing', async () => {
    const base = await listen(() => ({ running: false, lastRun: null, lastSyncedAt: null }));
    const port = Number(new URL(base).port);
    const lines: string[] = [];
    const second = startStatusServer({ port, host: '127.0.0.1', version: 'v', read: () => ({ running: false, lastRun: null, lastSyncedAt: null }), log: (m) => lines.push(m) });
    await once(second, 'error');
    expect(lines.join('\n')).toMatch(/Status page could not start/);
  });

  it('sets short timeouts', async () => {
    await listen(() => ({ running: false, lastRun: null, lastSyncedAt: null }));
    expect(server!.headersTimeout).toBe(5_000);
    expect(server!.requestTimeout).toBe(10_000);
    expect(server!.keepAliveTimeout).toBe(5_000);
  });
});
