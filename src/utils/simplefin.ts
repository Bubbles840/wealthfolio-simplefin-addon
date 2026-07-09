import type { SimplefinAccountSet } from '../../shared/types';

function requireHttps(url: string, label: string): void {
  if (!url.startsWith('https://')) {
    throw new Error(`${label} must use HTTPS — refusing HTTP URL`);
  }
}

export async function claimToken(setupToken: string): Promise<string> {
  const claimUrl = atob(setupToken);
  requireHttps(claimUrl, 'SimpleFin claim URL');

  const res = await fetch(claimUrl, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`SimpleFin claim failed: ${res.status}`);
  }
  const accessUrl = await res.text();
  requireHttps(accessUrl, 'SimpleFin access URL');
  return accessUrl;
}

export async function fetchAccounts(
  accessUrl: string,
  startDate: Date,
): Promise<SimplefinAccountSet> {
  requireHttps(accessUrl, 'SimpleFin access URL');

  // Extract credentials and base URL from the access URL
  const url = new URL(accessUrl);
  const credentials = btoa(`${url.username}:${url.password}`);
  url.username = '';
  url.password = '';

  const accountsUrl = new URL('/accounts', url.origin + url.pathname.replace(/\/$/, ''));
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
