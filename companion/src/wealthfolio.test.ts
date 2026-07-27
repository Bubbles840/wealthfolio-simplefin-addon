import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WealthfolioClient } from './wealthfolio';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => mockFetch.mockReset());

/** Login response: session JWT arrives via Set-Cookie, not the body */
function loginResponse(jwt = 'jwt-abc') {
  return {
    ok: true,
    headers: {
      getSetCookie: () => [`wf_session=${jwt}; HttpOnly; SameSite=Lax; Path=/api; Max-Age=3600`],
      get: () => null,
    },
    json: async () => ({ authenticated: true, expiresIn: 3600 }),
  };
}

describe('WealthfolioClient', () => {
  it('login POSTs password only and extracts the wf_session cookie as Bearer token', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    const client = new WealthfolioClient('http://wealthfolio:8088');
    await client.login('password');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wealthfolio:8088/api/v1/auth/login');
    expect(JSON.parse((opts as any).body)).toEqual({ password: 'password' });
  });

  it('falls back to the set-cookie header when getSetCookie is unavailable', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'wf_session=jwt-legacy; HttpOnly' },
      json: async () => ({}),
    });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

    const client = new WealthfolioClient('http://wealthfolio:8088');
    await client.login('password');
    await client.importActivities([]);
    const [, opts] = mockFetch.mock.calls[1];
    expect((opts as any).headers.Authorization).toBe('Bearer jwt-legacy');
  });

  it('throws when login returns no wf_session cookie', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { getSetCookie: () => [], get: () => null },
      json: async () => ({}),
    });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    await expect(client.login('password')).rejects.toThrow('wf_session');
  });

  it('importActivities POSTs to /activities/import with Bearer header', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

    const client = new WealthfolioClient('http://wealthfolio:8088');
    await client.login('password');
    await client.importActivities([{ accountId: 'wf-a', activityType: 'DEPOSIT' }]);

    const [url, opts] = mockFetch.mock.calls[1];
    expect(url).toBe('http://wealthfolio:8088/api/v1/activities/import');
    expect((opts as any).headers.Authorization).toBe('Bearer jwt-abc');
    expect(JSON.parse((opts as any).body).activities).toHaveLength(1);
  });

  it('works without credentials when no auth configured (unauthenticated mode)', async () => {
    const client = new WealthfolioClient('http://wealthfolio:8088');
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await client.importActivities([]);
    const [, opts] = mockFetch.mock.calls[0];
    expect((opts as any).headers.Authorization).toBeUndefined();
  });

  it('linkTransferActivities POSTs both ids to /activities/link', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [{}, {}] });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    await client.linkTransferActivities('act-out', 'act-in');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wealthfolio:8088/api/v1/activities/link');
    expect(JSON.parse((opts as any).body)).toEqual({ activityAId: 'act-out', activityBId: 'act-in' });
  });

  it('linkTransferActivities throws on non-ok status', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 422 });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    await expect(client.linkTransferActivities('a', 'b')).rejects.toThrow('422');
  });

  it('searchActivities POSTs filters and returns the data array', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 'act-1', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-07-05', amount: '500', sourceGroupId: null }], meta: {} }),
    });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    const items = await client.searchActivities({
      page: 1, pageSize: 200,
      accountIdFilter: ['wf-a'],
      activityTypeFilter: ['TRANSFER_IN', 'TRANSFER_OUT'],
      dateFrom: '2026-06-28',
    });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wealthfolio:8088/api/v1/activities/search');
    expect(JSON.parse((opts as any).body).activityTypeFilter).toEqual(['TRANSFER_IN', 'TRANSFER_OUT']);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('act-1');
  });

  it('reads an addon secret', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: 'https://u:p@bridge' }),
    });
    const c = new WealthfolioClient('http://wf');
    const v = await c.getAddonSecret('simplefin-sync', 'simplefin_access_url');
    expect(v).toBe('https://u:p@bridge');
    expect(mockFetch.mock.calls[0][0]).toBe('http://wf/api/v1/addons/simplefin-sync/secrets?key=simplefin_access_url');
  });

  it('returns null when getAddonSecret returns 404', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const c = new WealthfolioClient('http://wf');
    const v = await c.getAddonSecret('simplefin-sync', 'simplefin_access_url');
    expect(v).toBeNull();
  });

  it('sets an addon secret', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
    const c = new WealthfolioClient('http://wf');
    await c.setAddonSecret('simplefin-sync', 'my_key', 'my_val');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wf/api/v1/addons/simplefin-sync/secrets');
    expect(JSON.parse((opts as any).body)).toEqual({ key: 'my_key', value: 'my_val' });
  });

  it('saveMany POSTs to /api/v1/activities/bulk', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ created: [{ id: '1' }], updated: [], errors: [] }),
    });
    const c = new WealthfolioClient('http://wf');
    const res = await c.saveMany({ creates: [{ accountId: 'a', activityType: 'DEPOSIT' }] });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wf/api/v1/activities/bulk');
    expect(JSON.parse((opts as any).body)).toEqual({ creates: [{ accountId: 'a', activityType: 'DEPOSIT' }] });
    expect(res.created).toHaveLength(1);
  });
});
