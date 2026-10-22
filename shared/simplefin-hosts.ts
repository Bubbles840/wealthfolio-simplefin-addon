/**
 * Where a SimpleFin setup token may point. SimpleFin Bridge runs under
 * simplefin.org; Lunch Flow runs a SimpleFIN server of its own under
 * lunchflow.app, the one it feeds Actual Budget from (#25). Anything else is
 * refused, so a malicious setup token can't send the claim, or the Basic-auth
 * credentials the claim returns, to a server someone else controls.
 */
export const SIMPLEFIN_PROVIDER_DOMAINS = ['simplefin.org', 'lunchflow.app'] as const;

/** Whether `hostname` is one of the provider domains or a subdomain of one. */
export function isSimplefinProviderHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return SIMPLEFIN_PROVIDER_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function requireSimplefinProviderHost(url: string, label: string): void {
  const { hostname } = new URL(url);
  if (!isSimplefinProviderHost(hostname)) {
    throw new Error(`${label} must be hosted at ${SIMPLEFIN_PROVIDER_DOMAINS.join(' or ')} — got ${hostname}`);
  }
}

/**
 * The provider entries in manifest.json's `network.allowedHosts` (and
 * `approvedHosts`), as Wealthfolio's permission dialog lists them. Wealthfolio
 * matches an entry exactly, or a `*.` entry against any subdomain. Lunch Flow's
 * access URL host isn't documented, so its whole domain is listed.
 */
export const ADDON_PROVIDER_HOSTS = [
  'bridge.simplefin.org',
  'beta-bridge.simplefin.org',
  'lunchflow.app',
  '*.lunchflow.app',
] as const;

const entryCovers = (entry: string, host: string) => (entry.startsWith('*.')
  ? host.endsWith(entry.slice(1)) && host !== entry.slice(2)
  : host === entry);

/**
 * The manifest entries to tick when Wealthfolio refuses `host`: every entry of
 * its provider, since a claim on one host can be followed by a download from
 * another (Lunch Flow's access URL host isn't documented). Empty when no entry
 * covers the host: then ticking can't help.
 */
export function addonHostEntriesFor(host: string): string[] {
  const h = host.toLowerCase();
  if (!ADDON_PROVIDER_HOSTS.some((entry) => entryCovers(entry, h))) return [];
  const onDomain = (name: string, domain: string) => name === domain || name.endsWith(`.${domain}`);
  const domain = SIMPLEFIN_PROVIDER_DOMAINS.find((d) => onDomain(h, d))!;
  return ADDON_PROVIDER_HOSTS.filter((entry) => onDomain(entry.replace(/^\*\./, ''), domain));
}
