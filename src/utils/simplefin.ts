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

export async function claimToken(setupToken: string): Promise<string> {
  // SimpleFin tokens use URL-safe base64 (- instead of +, _ instead of /)
  const normalized = setupToken.replace(/-/g, '+').replace(/_/g, '/');
  const claimUrl = atob(normalized);
  requireHttps(claimUrl, 'SimpleFin claim URL');
  requireSimpleFinDomain(claimUrl, 'SimpleFin claim URL');

  const res = await fetch(claimUrl, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`SimpleFin claim failed: ${res.status}`);
  }
  const accessUrl = await res.text();
  requireHttps(accessUrl, 'SimpleFin access URL');
  requireSimpleFinDomain(accessUrl, 'SimpleFin access URL');
  return accessUrl;
}

export async function fetchAccounts(
  accessUrl: string,
  startDate: Date,
): Promise<SimplefinAccountSet> {
  requireHttps(accessUrl, 'SimpleFin access URL');
  requireSimpleFinDomain(accessUrl, 'SimpleFin access URL');

  // Extract credentials and base URL from the access URL
  const url = new URL(accessUrl);
  // btoa() only handles Latin-1. URL.username/password are percent-decoded by
  // the browser (e.g. '%C3%A9' → 'é'), so re-encode to stay within Latin-1.
  const credString = `${url.username}:${url.password}`;
  const credentials = btoa(
    encodeURIComponent(credString).replace(/%([0-9A-F]{2})/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    ),
  );
  url.username = '';
  url.password = '';

  const base = url.origin + url.pathname.replace(/\/$/, '');
  const accountsUrl = new URL(`${base}/accounts`);
  accountsUrl.searchParams.set('start-date', String(Math.floor(startDate.getTime() / 1000)));
  accountsUrl.searchParams.set('pending', '1');

  const res = await fetch(accountsUrl.toString(), {
    headers: { Authorization: `Basic ${credentials}` },
  });
  if (!res.ok) {
    throw new Error(`SimpleFin /accounts failed: ${res.status}`);
  }
  return res.json() as Promise<SimplefinAccountSet>;
}
