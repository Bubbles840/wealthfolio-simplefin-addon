import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WealthfolioClient } from './wealthfolio';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => mockFetch.mockReset());

describe('WealthfolioClient', () => {
  it('login POSTs credentials and stores Bearer token', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: 'jwt-abc' }),
    });
    const client = new WealthfolioClient('http://wealthfolio:7500');
    await client.login('admin', 'password');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://wealthfolio:7500/api/v1/auth/login',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('importActivities POSTs to /activities/import with Bearer header', async () => {
    // First call: login
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'jwt-abc' }) });
    // Second call: import
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

    const client = new WealthfolioClient('http://wealthfolio:7500');
    await client.login('admin', 'password');
    await client.importActivities([{ accountId: 'wf-a', activityType: 'DEPOSIT' }]);

    const [url, opts] = mockFetch.mock.calls[1];
    expect(url).toBe('http://wealthfolio:7500/api/v1/activities/import');
    expect((opts as any).headers.Authorization).toBe('Bearer jwt-abc');
    expect(JSON.parse((opts as any).body).activities).toHaveLength(1);
  });

  it('login works without credentials when no auth configured (unauthenticated mode)', async () => {
    const client = new WealthfolioClient('http://wealthfolio:7500');
    // No login called — should still be able to make requests using no-auth mode
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await client.importActivities([]);
    const [, opts] = mockFetch.mock.calls[0];
    expect((opts as any).headers.Authorization).toBeUndefined();
  });
});
