import { describe, it, expect, vi } from 'vitest';
import type { NetworkAPI } from '@wealthfolio/addon-sdk';
import { claimAccessUrl, credentialsB64 } from './connect';

function makeNetwork(requestImpl?: () => Promise<{ status: number; headers: Record<string, string>; body: string }>): NetworkAPI {
  return { request: vi.fn(requestImpl) } as unknown as NetworkAPI;
}

const CLAIM_URL = 'https://beta-bridge.simplefin.org/simplefin/claim/NEW';
const NEW_URL = 'https://new:secret2@beta-bridge.simplefin.org/simplefin';

describe('claimAccessUrl', () => {
  it('reuses the access URL a token already gave in this visit', async () => {
    const network = makeNetwork(async () => ({ status: 200, headers: {}, body: NEW_URL }));
    const first = await claimAccessUrl(`  ${btoa(CLAIM_URL)}\n`, network, null);
    expect(first).toEqual({ token: btoa(CLAIM_URL), accessUrl: NEW_URL });
    expect(await claimAccessUrl(btoa(CLAIM_URL), network, first)).toBe(first);
    expect(network.request).toHaveBeenCalledTimes(1);
  });
  it('claims a different token afresh', async () => {
    const network = makeNetwork(async () => ({ status: 200, headers: {}, body: NEW_URL }));
    await claimAccessUrl(btoa('https://bridge.simplefin.org/claim/OTHER'), network, { token: btoa(CLAIM_URL), accessUrl: NEW_URL });
    expect(network.request).toHaveBeenCalledWith({ url: 'https://bridge.simplefin.org/claim/OTHER', method: 'POST' });
  });
});

describe('credentialsB64', () => {
  it("is base64 of the URL's user:pass, as Setup always computed it", () => {
    expect(credentialsB64('https://user:pass@bridge.simplefin.org/simplefin')).toBe(btoa('user:pass'));
    // Percent-encoded as the URL holds it, not decoded: unchanged behaviour.
    expect(credentialsB64('https://u:p%2Bq@bridge.simplefin.org/simplefin')).toBe(btoa('u:p%2Bq'));
  });
});
