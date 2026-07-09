import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchAccountsNode } from './simplefin';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => mockFetch.mockReset());

describe('fetchAccountsNode', () => {
  it('calls /accounts with Basic auth', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errors: [], accounts: [] }),
    });
    await fetchAccountsNode('https://user:pass@bridge.simplefin.org/simplefin', new Date());
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/accounts');
    expect((opts as any).headers.Authorization).toMatch(/^Basic /);
  });

  it('rejects HTTP access URLs', async () => {
    await expect(
      fetchAccountsNode('http://user:pass@bridge.simplefin.org/simplefin', new Date()),
    ).rejects.toThrow('HTTPS');
  });
});
