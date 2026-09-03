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
  readLayout: vi.fn(async () => null),
  writeLayout: vi.fn(async () => {}),
  readCustomReports: vi.fn(async () => []),
  readHiddenSubscriptions: vi.fn(async () => []),
  readConfirmedSubscriptions: vi.fn(async () => []),
  now: () => NOW,
  ...over,
});

const pageBody = (extra: Record<string, string> = {}) =>
  new URLSearchParams({ initData: signedInitData(777), range: '6', ...extra }).toString();

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

describe('the board on the phone (v1.46)', () => {
  it('renders the user\'s board order and skips hidden cards', async () => {
    const d = deps({
      readLayout: vi.fn(async () => ({ heroes: [], order: [], hidden: ['cash-flow'] })),
    });
    const res = await handleReportsRequest(d, { method: 'POST', path: '/page', body: pageBody() });
    expect(res.body).not.toContain('>Cash flow<');
    expect(res.body).toContain('Net worth');
  });

  it('renders custom reports as charts of their evaluated series', async () => {
    const d = deps({
      readCustomReports: vi.fn(async () => [{
        id: 'cr-1', name: 'Food money', chart: 'line', range: { kind: 'all' }, accounts: null,
        series: [{ label: 'Food', terms: [{ sign: 1, source: 'category', category: 'Dining' }] }],
      }] as never),
    });
    const res = await handleReportsRequest(d, { method: 'POST', path: '/page', body: pageBody() });
    expect(res.body).toContain('Food money');
  });

  it('renders merchants and subscriptions as readable rows', async () => {
    const d = deps({
      readCube: vi.fn(async () => ({ ...CUBE, subscriptions: [
        { name: 'SPOTIFY', monthlyCents: 1099, count: 5, lastDate: '2026-08-20', lastCents: 1099, creep: false, kind: 'subscription' },
      ] } as never)),
    });
    const res = await handleReportsRequest(d, { method: 'POST', path: '/page', body: pageBody() });
    expect(res.body).toContain('CHIPOTLE');
    expect(res.body).toContain('SPOTIFY');
    expect(res.body).toContain('$10.99');
  });

  it('honors the headline picks for the tile strip', async () => {
    const d = deps({
      readLayout: vi.fn(async () => ({ heroes: [], order: [], hidden: [], headline: ['net-worth'] })),
    });
    const res = await handleReportsRequest(d, { method: 'POST', path: '/page', body: pageBody() });
    expect(res.body).toContain('Net worth');
    expect(res.body).not.toContain('Savings rate</span>');
  });

  it('card controls write the shared layout: hide, then it is gone', async () => {
    const writeLayout = vi.fn(async () => {});
    const d = deps({ writeLayout });
    const res = await handleReportsRequest(d, { method: 'POST', path: '/page', body: pageBody({ action: 'hide:net-worth' }) });
    expect(writeLayout).toHaveBeenCalled();
    const written = writeLayout.mock.calls[0][0] as { hidden: string[] };
    expect(written.hidden).toContain('net-worth');
  });

  it('every card carries move and hide controls', async () => {
    const res = await handleReportsRequest(deps(), { method: 'POST', path: '/page', body: pageBody() });
    expect(res.body).toContain('data-action="up:net-worth"');
    expect(res.body).toContain('data-action="hide:net-worth"');
  });
});

describe('phone arrows are reading-order (v1.46.1)', () => {
  it('▲ moves exactly one slot even across side-by-side cards', async () => {
    const writeLayout = vi.fn(async () => {});
    const d = deps({
      writeLayout,
      readLayout: vi.fn(async () => ({
        heroes: [], order: [], hidden: [],
        pos: { 'cash-flow': [0, 0, 8, 8], 'net-worth': [8, 0, 4, 8], 'category-trends': [0, 8, 4, 8] },
      } as never)),
    });
    await handleReportsRequest(d, { method: 'POST', path: '/page', body: pageBody({ action: 'up:category-trends' }) });
    const written = writeLayout.mock.calls[0][0] as { pos: Record<string, number[]> };
    const order = Object.entries(written.pos)
      .filter(([id]) => ['cash-flow', 'net-worth', 'category-trends'].includes(id))
      .sort(([, a], [, b]) => a[1] - b[1] || a[0] - b[0])
      .map(([id]) => id);
    expect(order.indexOf('category-trends')).toBe(1);
  });
});
