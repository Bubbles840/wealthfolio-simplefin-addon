import { describe, it, expect, vi, beforeEach } from 'vitest';
import { claimTokenNode, fetchAccountsNode } from './simplefin';

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
    expect(url).toContain('/simplefin/accounts');
    expect((opts as any).headers.Authorization).toMatch(/^Basic /);
  });

  it('rejects HTTP access URLs', async () => {
    await expect(
      fetchAccountsNode('http://user:pass@bridge.simplefin.org/simplefin', new Date()),
    ).rejects.toThrow('HTTPS');
  });

  it('fetches from a Lunch Flow access URL (#25)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errors: [], accounts: [] }),
    });
    await fetchAccountsNode('https://user:pass@www.lunchflow.app/simplefin', new Date());
    const [url] = mockFetch.mock.calls[0];
    expect(new URL(url).hostname).toBe('www.lunchflow.app');
  });

  it('asks SimpleFIN Bridge for protocol v2, and sends Lunch Flow the request it always sent (#81)', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ errors: [], accounts: [] }) });
    await fetchAccountsNode('https://u:p@beta-bridge.simplefin.org/simplefin', new Date('2024-01-01T00:00:00Z'));
    await fetchAccountsNode('https://u:p@www.lunchflow.app/simplefin', new Date('2024-01-01T00:00:00Z'));
    expect(mockFetch.mock.calls[0][0]).toBe('https://beta-bridge.simplefin.org/simplefin/accounts?start-date=1704067200&pending=1&version=2');
    expect(mockFetch.mock.calls[1][0]).toBe('https://www.lunchflow.app/simplefin/accounts?start-date=1704067200&pending=1');
  });

  it('requests pending transactions', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errors: [], accounts: [] }),
    });
    await fetchAccountsNode('https://u:p@bridge.simplefin.org/simplefin', new Date(0));
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('pending=1');
  });
});

describe('claimTokenNode', () => {
  const token = (url: string) => Buffer.from(url).toString('base64');

  it('claims a Lunch Flow setup token (#25)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'https://u:p@www.lunchflow.app/simplefin' });
    expect(await claimTokenNode(token('https://www.lunchflow.app/simplefin/claim/x'))).toBe('https://u:p@www.lunchflow.app/simplefin');
  });

  it('refuses a host that is neither SimpleFin nor Lunch Flow', async () => {
    await expect(claimTokenNode(token('https://evil.com/claim/x')))
      .rejects.toThrow('must be hosted at simplefin.org or lunchflow.app — got evil.com');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
