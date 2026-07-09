import { describe, it, expect, vi, beforeEach } from 'vitest';
import { claimToken, fetchAccounts } from './simplefin';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => mockFetch.mockReset());

describe('claimToken', () => {
  it('decodes base64 token and POSTs to /claim endpoint', async () => {
    // base64 of "https://bridge.simplefin.org/simplefin/claim/abc123"
    const rawUrl = 'https://bridge.simplefin.org/simplefin/claim/abc123';
    const token = btoa(rawUrl);
    const accessUrl = 'https://user:pass@bridge.simplefin.org/simplefin';

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => accessUrl,
    });

    const result = await claimToken(token);

    expect(mockFetch).toHaveBeenCalledWith(rawUrl, { method: 'POST' });
    expect(result).toBe(accessUrl);
  });

  it('throws when the claim response is not ok', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, text: async () => '' });
    await expect(claimToken(btoa('https://example.com/claim/x'))).rejects.toThrow('403');
  });

  it('throws when decoded URL is not HTTPS', async () => {
    await expect(claimToken(btoa('http://bridge.simplefin.org/claim/x'))).rejects.toThrow('HTTPS');
  });
});

describe('fetchAccounts', () => {
  it('calls /accounts with start-date param and Basic auth', async () => {
    const accessUrl = 'https://user:pass@bridge.simplefin.org/simplefin';
    const startDate = new Date('2024-01-01T00:00:00Z');
    const expected = { errors: [], accounts: [] };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => expected,
    });

    const result = await fetchAccounts(accessUrl, startDate);

    const [calledUrl, calledOpts] = mockFetch.mock.calls[0];
    expect(calledUrl).toContain('/accounts');
    expect(calledUrl).toContain(`start-date=${Math.floor(startDate.getTime() / 1000)}`);
    expect(calledUrl).toMatch(/^https:/); // never HTTP
    expect((calledOpts as RequestInit).headers).toMatchObject({
      Authorization: expect.stringMatching(/^Basic /),
    });
    expect(result).toEqual(expected);
  });

  it('throws when access URL is not HTTPS', async () => {
    await expect(
      fetchAccounts('http://user:pass@example.com/simplefin', new Date()),
    ).rejects.toThrow('HTTPS');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    await expect(
      fetchAccounts('https://user:pass@bridge.simplefin.org/simplefin', new Date()),
    ).rejects.toThrow('401');
  });
});
