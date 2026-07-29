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
    expect(JSON.parse((opts as any).body)).toEqual({
      activities: [{ accountId: 'wf-a', activityType: 'DEPOSIT' }],
    });
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
      page: 0, pageSize: 200,
      accountIdFilter: ['wf-a'],
      activityTypeFilter: ['TRANSFER_IN', 'TRANSFER_OUT'],
      dateFrom: '2026-06-28',
    });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wealthfolio:8088/api/v1/activities/search');
    // The whole body goes to the wire verbatim - in particular `page`, which is
    // 0-indexed on this endpoint. A client that "helpfully" adjusted the page
    // number would resurrect the empty-first-page bug.
    expect(JSON.parse((opts as any).body)).toEqual({
      page: 0, pageSize: 200,
      accountIdFilter: ['wf-a'],
      activityTypeFilter: ['TRANSFER_IN', 'TRANSFER_OUT'],
      dateFrom: '2026-06-28',
    });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('act-1');
  });

  it('reads an addon secret', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '"https://u:p@bridge"',
      json: async () => 'https://u:p@bridge',
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

  it('setAddonSecret POSTs { key, secret } (not { key, value }) with auth headers', async () => {
    // Regression test: the real server rejects { key, value } with HTTP 422
    // ("missing field `secret`"). Pin the exact wire shape so a future
    // "helpful" rename can't silently reintroduce the bug.
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });

    const client = new WealthfolioClient('http://wf');
    await client.login('password');
    await client.setAddonSecret('simplefin-sync', 'my_key', 'my_val');

    const [url, opts] = mockFetch.mock.calls[1];
    expect(url).toBe('http://wf/api/v1/addons/simplefin-sync/secrets');
    expect((opts as any).method).toBe('POST');
    expect((opts as any).headers['Content-Type']).toBe('application/json');
    expect((opts as any).headers.Authorization).toBe('Bearer jwt-abc');
    expect(JSON.parse((opts as any).body)).toEqual({ key: 'my_key', secret: 'my_val' });
  });

  it('checkImport POSTs { accountId, activities } to /activities/import/check', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

    const client = new WealthfolioClient('http://wf');
    await client.login('password');
    await client.checkImport('wf-a', [{ activityType: 'DEPOSIT' }]);

    const [url, opts] = mockFetch.mock.calls[1];
    expect(url).toBe('http://wf/api/v1/activities/import/check');
    expect((opts as any).method).toBe('POST');
    expect((opts as any).headers.Authorization).toBe('Bearer jwt-abc');
    expect(JSON.parse((opts as any).body)).toEqual({
      accountId: 'wf-a',
      activities: [{ activityType: 'DEPOSIT' }],
    });
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

  describe('error detail on non-ok responses', () => {
    it('surfaces the server response body, not just the status code', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () =>
          'Failed to deserialize the JSON body into the target type: missing field `secret` at line 1 column 36',
      });
      const client = new WealthfolioClient('http://wf');
      await expect(client.setAddonSecret('simplefin-sync', 'my_key', 'super-secret-value')).rejects.toThrow(
        /missing field `secret`/,
      );
    });

    it('never echoes the secret value into a setAddonSecret error, even on failure', async () => {
      // Only the *response* body may appear in the error - never the request
      // body, which is where the secret being written lives.
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'internal server error',
      });
      const client = new WealthfolioClient('http://wf');
      let caught: Error | undefined;
      try {
        await client.setAddonSecret('simplefin-sync', 'my_key', 'super-secret-value');
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toContain('internal server error');
      expect(caught!.message).not.toContain('super-secret-value');
    });

    it('bounds a large response body so a huge HTML error page cannot flood the logs', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'x'.repeat(5000) });
      const client = new WealthfolioClient('http://wf');
      let caught: Error | undefined;
      try {
        await client.getAccounts();
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message.length).toBeLessThan(400);
    });

    it('falls back to a status-only message when the body cannot be read', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => {
          throw new Error('stream already consumed');
        },
      });
      const client = new WealthfolioClient('http://wf');
      await expect(client.getAccounts()).rejects.toThrow('getAccounts failed: 503');
    });
  });
});
