import type { SimplefinAccountSet } from '../../shared/types';
import { normalizeAccountSet } from '../../shared/simplefin-payload.js';
import { requireSimplefinProviderHost } from '../../shared/simplefin-hosts.js';

function requireHttps(url: string): void {
  if (!url.startsWith('https://')) {
    throw new Error('SimpleFin access URL must use HTTPS — refusing HTTP URL');
  }
}

/**
 * Exchange a one-time SimpleFin setup token for an access URL.
 * The token is a base64-encoded claim URL; POSTing to it returns the
 * access URL (which embeds the Basic-auth credentials).
 */
export async function claimTokenNode(setupToken: string): Promise<string> {
  // SimpleFin tokens use URL-safe base64 (- instead of +, _ instead of /)
  const normalized = setupToken.trim().replace(/-/g, '+').replace(/_/g, '/');
  const claimUrl = Buffer.from(normalized, 'base64').toString('utf8');
  requireHttps(claimUrl);
  requireSimplefinProviderHost(claimUrl, 'SimpleFin claim URL');

  const res = await fetch(claimUrl, { method: 'POST' });
  if (!res.ok) throw new Error(`SimpleFin claim failed: ${res.status}`);
  const accessUrl = (await res.text()).trim();
  requireHttps(accessUrl);
  requireSimplefinProviderHost(accessUrl, 'SimpleFin access URL');
  return accessUrl;
}

export async function fetchAccountsNode(
  accessUrl: string,
  startDate: Date,
): Promise<SimplefinAccountSet> {
  requireHttps(accessUrl);
  const url = new URL(accessUrl);
  const credentials = Buffer.from(`${url.username}:${url.password}`).toString('base64');
  url.username = '';
  url.password = '';

  const base = url.origin + url.pathname.replace(/\/$/, '');
  const accountsUrl = new URL(`${base}/accounts`);
  accountsUrl.searchParams.set('start-date', String(Math.floor(startDate.getTime() / 1000)));
  accountsUrl.searchParams.set('pending', '1');

  const res = await fetch(accountsUrl.toString(), {
    headers: { Authorization: `Basic ${credentials}` },
  });
  if (!res.ok) throw new Error(`SimpleFin /accounts failed: ${res.status}`);
  // Same normalisation as the addon half (shared/simplefin-payload.ts), so both
  // syncers see identical errors and neither trusts a field to be present.
  return normalizeAccountSet(await res.json());
}
