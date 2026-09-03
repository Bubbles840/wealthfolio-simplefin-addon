import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { handleReportsRequest, type ReportsServerDeps } from './reports-server.js';
import { CUBE } from '../../shared/report-cube.test';

const TOKEN = '12345:TEST-TOKEN';
const NOW = new Date('2026-09-02T22:00:00Z');

function signedInitData(userId: number): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(NOW.getTime() / 1000) - 30),
    user: JSON.stringify({ id: userId, first_name: 'Nick' }),
  };
  const dataCheck = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dataCheck).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const deps = (over: Partial<ReportsServerDeps> = {}): ReportsServerDeps => ({
  botToken: vi.fn(async () => TOKEN),
  allowedUserIds: vi.fn(async () => [777]),
  readCube: vi.fn(async () => ({ ...CUBE })),
  now: () => NOW,
  ...over,
});

describe('handleReportsRequest', () => {
  it('serves the bootstrap page that hands Telegram initData to /page', async () => {
    const res = await handleReportsRequest(deps(), { method: 'GET', path: '/', body: '' });
    expect(res.status).toBe(200);
    expect(res.body).toContain('telegram-web-app.js');
    // Relative, not absolute: the page must keep working when proxied under
    // a path prefix (tailscale serve --set-path).
    expect(res.body).toContain("fetch('page'");
  });

  it('renders the dashboard for a signed, allowed user', async () => {
    const body = new URLSearchParams({ initData: signedInitData(777), range: '6' }).toString();
    const res = await handleReportsRequest(deps(), { method: 'POST', path: '/page', body });
    expect(res.status).toBe(200);
    expect(res.body).toContain('<svg');
    expect(res.body).toContain('Spent this month');
    expect(res.body).toContain('Cash flow');
  });

  it('refuses a valid signature from a user not on the list', async () => {
    const body = new URLSearchParams({ initData: signedInitData(999), range: '6' }).toString();
    const res = await handleReportsRequest(deps(), { method: 'POST', path: '/page', body });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('<svg');
  });

  it('refuses a bad signature outright', async () => {
    const body = new URLSearchParams({ initData: 'auth_date=1&hash=deadbeef', range: '6' }).toString();
    const res = await handleReportsRequest(deps(), { method: 'POST', path: '/page', body });
    expect(res.status).toBe(401);
  });

  it('says the companion has no cube yet rather than erroring', async () => {
    const body = new URLSearchParams({ initData: signedInitData(777) }).toString();
    const res = await handleReportsRequest(deps({ readCube: vi.fn(async () => null) }), { method: 'POST', path: '/page', body });
    expect(res.status).toBe(200);
    expect(res.body).toContain('after the next sync');
  });

  it('404s anything else', async () => {
    const res = await handleReportsRequest(deps(), { method: 'GET', path: '/etc/passwd', body: '' });
    expect(res.status).toBe(404);
  });
});
