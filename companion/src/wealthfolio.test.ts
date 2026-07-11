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
});
