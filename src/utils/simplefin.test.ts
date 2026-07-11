import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NetworkAPI } from '@wealthfolio/addon-sdk';
import { claimToken, fetchAccounts } from './simplefin';

function makeNetwork(requestImpl?: () => Promise<{ status: number; headers: Record<string, string>; body: string }>): NetworkAPI {
  return { request: vi.fn(requestImpl) } as unknown as NetworkAPI;
}

function okResponse(body: string) {
  return Promise.resolve({ status: 200, headers: {}, body });
}

function errResponse(status: number) {
  return Promise.resolve({ status, headers: {}, body: '' });
}

beforeEach(() => vi.clearAllMocks());

describe('claimToken', () => {
  it('decodes base64 token and POSTs to /claim endpoint', async () => {
    const rawUrl = 'https://bridge.simplefin.org/simplefin/claim/abc123';
    const token = btoa(rawUrl);
    const accessUrl = 'https://user:pass@bridge.simplefin.org/simplefin';
    const network = makeNetwork(() => okResponse(accessUrl));

    const result = await claimToken(token, network);

    expect(network.request).toHaveBeenCalledWith({ url: rawUrl, method: 'POST' });
    expect(result).toBe(accessUrl);
  });

  it('throws when the claim response is not ok', async () => {
    const network = makeNetwork(() => errResponse(403));
    await expect(claimToken(btoa('https://bridge.simplefin.org/claim/x'), network)).rejects.toThrow('403');
  });

  it('throws when decoded URL is not HTTPS', async () => {
    const network = makeNetwork();
    await expect(claimToken(btoa('http://bridge.simplefin.org/claim/x'), network)).rejects.toThrow('HTTPS');
  });

  it('throws when claim URL is not a simplefin.org domain', async () => {
    const network = makeNetwork();
    await expect(claimToken(btoa('https://evil.com/claim/x'), network)).rejects.toThrow('simplefin.org');
  });

  it('throws when access URL returned by claim is not a simplefin.org domain', async () => {
    const network = makeNetwork(() => okResponse('https://evil.com/simplefin'));
    await expect(
      claimToken(btoa('https://bridge.simplefin.org/claim/x'), network),
    ).rejects.toThrow('simplefin.org');
  });

  it('handles URL-safe base64 tokens (- and _)', async () => {
    const rawUrl = 'https://bridge.simplefin.org/simplefin/claim/abc123';
    const token = btoa(rawUrl).replace(/\+/g, '-').replace(/\//g, '_');
    const network = makeNetwork(() => okResponse('https://user:pass@bridge.simplefin.org/simplefin'));
    const result = await claimToken(token, network);
    expect(result).toBe('https://user:pass@bridge.simplefin.org/simplefin');
  });
});

describe('fetchAccounts', () => {
  it('calls /accounts with start-date param, no URL credentials, and bearer auth key', async () => {
    const accessUrl = 'https://user:pass@bridge.simplefin.org/simplefin';
    const startDate = new Date('2024-01-01T00:00:00Z');
    const expected = { errors: [], accounts: [] };
    const network = makeNetwork(() => okResponse(JSON.stringify(expected)));

    const result = await fetchAccounts(accessUrl, startDate, network, 'simplefin_auth_b64');

    const [calledReq] = (network.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledReq.url).toContain('/simplefin/accounts');
    expect(calledReq.url).toContain(`start-date=${Math.floor(startDate.getTime() / 1000)}`);
    expect(calledReq.url).not.toContain('user:pass@');
    expect(calledReq.url).toMatch(/^https:/);
    expect(calledReq.auth).toEqual({ type: 'basic', secretKey: 'simplefin_auth_b64' });
    expect(result).toEqual(expected);
  });

  it('calls /accounts without auth when no authSecretKey provided', async () => {
    const accessUrl = 'https://user:pass@bridge.simplefin.org/simplefin';
    const network = makeNetwork(() => okResponse(JSON.stringify({ errors: [], accounts: [] })));
    await fetchAccounts(accessUrl, new Date(), network);
    const [calledReq] = (network.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledReq.auth).toBeUndefined();
  });

  it('throws when access URL is not HTTPS', async () => {
    await expect(
      fetchAccounts('http://user:pass@bridge.simplefin.org/simplefin', new Date(), makeNetwork()),
    ).rejects.toThrow('HTTPS');
  });

  it('throws when access URL is not a simplefin.org domain', async () => {
    await expect(
      fetchAccounts('https://user:pass@evil.com/simplefin', new Date(), makeNetwork()),
    ).rejects.toThrow('simplefin.org');
  });

  it('throws on non-ok response', async () => {
    const network = makeNetwork(() => errResponse(401));
    await expect(
      fetchAccounts('https://user:pass@bridge.simplefin.org/simplefin', new Date(), network),
    ).rejects.toThrow('401');
  });
});
