import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NetworkAPI } from '@wealthfolio/addon-sdk';
import {
  claimToken,
  fetchAccounts,
  SimplefinRequestError,
  SIMPLEFIN_UNREACHABLE_MESSAGE,
} from './simplefin';

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

  describe('error classification', () => {
    /** The verbatim message the Wealthfolio network broker rejects with when the
     *  request never completes — what the user actually saw in the error box,
     *  internal URL and query params included. */
    const TRANSPORT_FAILURE =
      'error sending request for url (https://beta-bridge.simplefin.org/simplefin/accounts?start-date=1777688539&pending=1)';

    const failing = (message: string) =>
      ({ request: vi.fn(async () => { throw new Error(message); }) }) as unknown as NetworkAPI;

    /** Awaits a rejection and hands back the typed error. Fails loudly if the
     *  call resolves instead — silently reading `.kind` off an account set would
     *  make an "unclassified" regression look like a pass. */
    async function rejection(p: Promise<unknown>): Promise<SimplefinRequestError> {
      let caught: unknown;
      let resolved = false;
      try { await p; resolved = true; } catch (e) { caught = e; }
      if (resolved) throw new Error('expected fetchAccounts to reject, but it resolved');
      return caught as SimplefinRequestError;
    }

    it('turns a transport failure into something actionable that leaks no URL', async () => {
      const err = await rejection(fetchAccounts(
        'https://user:pass@bridge.simplefin.org/simplefin', new Date(), failing(TRANSPORT_FAILURE),
      ));

      expect(err).toBeInstanceOf(SimplefinRequestError);
      expect(err.kind).toBe('network');
      expect(err.message).toBe(SIMPLEFIN_UNREACHABLE_MESSAGE);
      // The two things that made the raw message a defect: an internal URL, and
      // query params that tell the reader nothing they can act on.
      expect(err.message).not.toContain('http');
      expect(err.message).not.toContain('start-date');
      // ...and it says it is probably transient, because it is: this shows up
      // after several rapid syncs, i.e. SimpleFin throttling.
      expect(err.message).toMatch(/temporar/i);
    });

    it('keeps the raw transport message on the error rather than discarding it', async () => {
      // Days of debugging depended on real error text reaching the surface, so
      // classifying must not swallow it — the UI shows it as a collapsed detail.
      const err = await rejection(fetchAccounts(
        'https://user:pass@bridge.simplefin.org/simplefin', new Date(), failing(TRANSPORT_FAILURE),
      ));
      expect(err.detail).toBe(TRANSPORT_FAILURE);
    });

    it('keeps the status AND the body on an HTTP error — both are diagnostic', async () => {
      // NOT the transient case: a revoked access URL surfaces as a 403 with a
      // message, and blanket-friendlying that would hide the one error whose
      // text says what to do about it.
      const network = makeNetwork(() => Promise.resolve({
        status: 403, headers: {}, body: 'Forbidden: access URL has been revoked',
      }));
      const err = await rejection(fetchAccounts(
        'https://user:pass@bridge.simplefin.org/simplefin', new Date(), network,
      ));

      expect(err.kind).toBe('http');
      expect(err.status).toBe(403);
      expect(err.message).toContain('403');
      expect(err.message).toContain('access URL has been revoked');
      expect(err.message).not.toBe(SIMPLEFIN_UNREACHABLE_MESSAGE);
    });

    it('still reports a bare status when the response carries no body', async () => {
      const err = await rejection(fetchAccounts(
        'https://user:pass@bridge.simplefin.org/simplefin', new Date(), makeNetwork(() => errResponse(500)),
      ));
      expect(err.message).toBe('SimpleFin /accounts failed: 500');
    });

    it('truncates a runaway body instead of pasting a whole HTML page into the UI', async () => {
      const network = makeNetwork(() => Promise.resolve({
        status: 502, headers: {}, body: `<html>${'x'.repeat(5000)}</html>`,
      }));
      const err = await rejection(fetchAccounts(
        'https://user:pass@bridge.simplefin.org/simplefin', new Date(), network,
      ));
      expect(err.message).toContain('502');
      expect(err.message.length).toBeLessThan(300);
    });

    it('leaves the HTTPS and domain guards alone — those are real, actionable errors', async () => {
      // They fire before any request, so classification must not reach them.
      await expect(
        fetchAccounts('http://user:pass@bridge.simplefin.org/simplefin', new Date(), makeNetwork()),
      ).rejects.toThrow('HTTPS');
      await expect(
        fetchAccounts('https://user:pass@evil.com/simplefin', new Date(), makeNetwork()),
      ).rejects.toThrow('simplefin.org');
    });
  });

  it('requests pending transactions', async () => {
    const network = makeNetwork(() => okResponse('{"errors":[],"accounts":[]}'));
    await fetchAccounts('https://u:p@bridge.simplefin.org/simplefin', new Date(0), network);
    const [calledReq] = (network.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledReq.url).toContain('pending=1');
  });
});
