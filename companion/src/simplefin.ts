import type { SimplefinAccountSet } from '../../shared/types';

function requireHttps(url: string): void {
  if (!url.startsWith('https://')) {
    throw new Error('SimpleFin access URL must use HTTPS — refusing HTTP URL');
  }
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

  const accountsUrl = new URL('/accounts', url.origin + url.pathname.replace(/\/$/, ''));
  accountsUrl.searchParams.set('start-date', String(Math.floor(startDate.getTime() / 1000)));
  accountsUrl.searchParams.set('pending', '1');

  const res = await fetch(accountsUrl.toString(), {
    headers: { Authorization: `Basic ${credentials}` },
  });
  if (!res.ok) throw new Error(`SimpleFin /accounts failed: ${res.status}`);
  return res.json() as Promise<SimplefinAccountSet>;
}
