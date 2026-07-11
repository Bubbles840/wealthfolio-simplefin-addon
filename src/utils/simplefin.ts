import type { NetworkAPI } from '@wealthfolio/addon-sdk';
import type { SimplefinAccountSet } from '../../shared/types';

function requireHttps(url: string, label: string): void {
  if (!url.startsWith('https://')) {
    throw new Error(`${label} must use HTTPS — refusing HTTP URL`);
  }
}

// All known SimpleFin bridges run under simplefin.org. Rejecting other domains
// prevents a malicious setup token from redirecting account fetches (and the
// embedded Basic-auth credentials) to an attacker-controlled server.
function requireSimpleFinDomain(url: string, label: string): void {
  const { hostname } = new URL(url);
  if (hostname !== 'simplefin.org' && !hostname.endsWith('.simplefin.org')) {
    throw new Error(
      `${label} must be hosted at simplefin.org — got ${hostname}`,
    );
  }
}

export async function claimToken(setupToken: string, network: NetworkAPI): Promise<string> {
  // SimpleFin tokens use URL-safe base64 (- instead of +, _ instead of /)
  const normalized = setupToken.replace(/-/g, '+').replace(/_/g, '/');
  const claimUrl = atob(normalized);
  requireHttps(claimUrl, 'SimpleFin claim URL');
  requireSimpleFinDomain(claimUrl, 'SimpleFin claim URL');

  const res = await network.request({ url: claimUrl, method: 'POST' });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`SimpleFin claim failed: ${res.status}`);
  }
  const accessUrl = res.body.trim();
  requireHttps(accessUrl, 'SimpleFin access URL');
  requireSimpleFinDomain(accessUrl, 'SimpleFin access URL');
  return accessUrl;
}

export async function fetchAccounts(
  accessUrl: string,
  startDate: Date,
  network: NetworkAPI,
  authSecretKey?: string,
): Promise<SimplefinAccountSet> {
  requireHttps(accessUrl, 'SimpleFin access URL');
  requireSimpleFinDomain(accessUrl, 'SimpleFin access URL');

  // Strip credentials from URL — Wealthfolio blocks URL-embedded credentials
  // and direct Authorization headers. Instead we reference a stored secret via
  // auth.secretKey; the backend injects "Authorization: Bearer <secret>" where
  // the secret is the pre-computed base64(user:pass) from the access URL.
  const url = new URL(accessUrl);
  url.username = '';
  url.password = '';
  url.pathname = url.pathname.replace(/\/$/, '') + '/accounts';
  url.searchParams.set('start-date', String(Math.floor(startDate.getTime() / 1000)));

  const req: Parameters<NetworkAPI['request']>[0] = { url: url.href, method: 'GET' };
  if (authSecretKey) {
    // SDK types only expose 'bearer', but our patched Wealthfolio backend also
    // supports 'basic' (injects "Authorization: Basic <secret>"). SimpleFin
    // requires Basic auth; bearer does not work.
    req.auth = { type: 'basic' as 'bearer', secretKey: authSecretKey };
  }

  const res = await network.request(req);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`SimpleFin /accounts failed: ${res.status}`);
  }
  return JSON.parse(res.body) as SimplefinAccountSet;
}
