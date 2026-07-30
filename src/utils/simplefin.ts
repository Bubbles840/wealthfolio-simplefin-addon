import type { NetworkAPI } from '@wealthfolio/addon-sdk';
import type { SimplefinAccountSet } from '../../shared/types';

/**
 * What the user is told when the request to SimpleFin never completed.
 *
 * Replaces the broker's raw rejection, which read (verbatim, in the error box):
 * `error sending request for url (https://beta-bridge.simplefin.org/simplefin/accounts?start-date=…&pending=1)`
 * — an internal URL and its query params, and nothing the reader can act on. In
 * this deployment that failure has always been transient, showing up after
 * several syncs in quick succession, i.e. SimpleFin throttling; it is NOT how an
 * auth problem surfaces (that is a 403 carrying a message, which keeps its own
 * text — see `SimplefinRequestError`).
 */
export const SIMPLEFIN_UNREACHABLE_MESSAGE =
  "Couldn't reach SimpleFin — usually temporary, often after several syncs in quick succession. Try again shortly.";

/** Longest body excerpt folded into an HTTP error message. A 502 from a proxy
 *  can return an entire HTML page, and the whole thing in the error box is as
 *  unreadable as no message at all. The full text survives on `detail`. */
const MAX_BODY_EXCERPT = 160;

/**
 * A failed SimpleFin request, classified so the UI can be kind about the one
 * failure mode that is transient and honest about every other.
 *
 * `kind: 'network'` means the request never completed — the message is the
 * friendly line above, because the underlying text is an internal URL. Anything
 * else keeps its status AND its body excerpt in `message`: those are the errors
 * whose text tells you what to do (a revoked access URL 403s with a reason), and
 * blanket-rewriting them into a friendly string is exactly how the last few days
 * of debugging would have been impossible.
 *
 * `detail` always carries the raw underlying text either way, so nothing is
 * discarded — the Sync page shows it as a collapsed detail line beside the
 * message rather than as the message.
 */
export class SimplefinRequestError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'http',
    readonly detail: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SimplefinRequestError';
  }
}

/** Collapses whitespace and clips, so a body excerpt stays one readable line. */
function excerpt(body: string): string {
  const clean = body.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_BODY_EXCERPT ? `${clean.slice(0, MAX_BODY_EXCERPT)}…` : clean;
}

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
  url.searchParams.set('pending', '1');

  const req: Parameters<NetworkAPI['request']>[0] = { url: url.href, method: 'GET' };
  if (authSecretKey) {
    // SDK types only expose 'bearer', but our patched Wealthfolio backend also
    // supports 'basic' (injects "Authorization: Basic <secret>"). SimpleFin
    // requires Basic auth; bearer does not work.
    req.auth = { type: 'basic' as 'bearer', secretKey: authSecretKey };
  }

  // The classification seam. Everything above throws before a request is made
  // (the HTTPS and domain guards), and those messages are already actionable, so
  // only the request itself is wrapped.
  let res: Awaited<ReturnType<NetworkAPI['request']>>;
  try {
    res = await network.request(req);
  } catch (err) {
    throw new SimplefinRequestError(
      SIMPLEFIN_UNREACHABLE_MESSAGE,
      'network',
      String((err as Error)?.message ?? err),
    );
  }
  if (res.status < 200 || res.status >= 300) {
    // Status first so it is never lost, then whatever the body said. Only the
    // *transport* failure is rewritten; a status carries real information.
    const body = excerpt(res.body ?? '');
    throw new SimplefinRequestError(
      `SimpleFin /accounts failed: ${res.status}${body ? ` — ${body}` : ''}`,
      'http',
      res.body ?? '',
      res.status,
    );
  }
  return JSON.parse(res.body) as SimplefinAccountSet;
}
