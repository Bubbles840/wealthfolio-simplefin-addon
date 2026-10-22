import type { NetworkAPI } from '@wealthfolio/addon-sdk';
import type { SimplefinAccountSet } from '../../shared/types';
import { normalizeAccountSet } from '../../shared/simplefin-payload';
import { addonHostEntryFor, requireSimplefinProviderHost } from '../../shared/simplefin-hosts';

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

/**
 * Wealthfolio's refusal of a host this add-on hasn't been approved for, turned
 * into where to approve it; null for any other failure. An update that adds a
 * host to the manifest leaves it unticked until the person ticks it, so a
 * Lunch Flow token pasted after updating lands here (#25). The request never
 * left Wealthfolio.
 */
export function hostNotApprovedMessage(err: unknown): string | null {
  const match = /host '([^']+)' is not approved/.exec(String((err as Error)?.message ?? err));
  if (!match) return null;
  return `Wealthfolio hasn't approved this add-on to connect to ${match[1]}. `
    + `Open Settings → Add-ons → SimpleFin Sync → View permissions, tick ${addonHostEntryFor(match[1])} under Network hosts, and try again.`;
}

export async function claimToken(setupToken: string, network: NetworkAPI): Promise<string> {
  // SimpleFin tokens use URL-safe base64 (- instead of +, _ instead of /)
  const normalized = setupToken.trim().replace(/-/g, '+').replace(/_/g, '/');
  let claimUrl: string;
  try {
    claimUrl = atob(normalized);
    new URL(claimUrl);
  } catch {
    // atob's own message ("The string to be decoded is not correctly
    // encoded") says nothing about what to do. The usual cause is pasting the
    // access URL, or only part of the token.
    throw new Error(
      'That does not look like a SimpleFin setup token. Copy the whole token from SimpleFin Bridge '
      + '(a long string of letters and numbers), not the access URL or your login.',
    );
  }
  requireHttps(claimUrl, 'SimpleFin claim URL');
  requireSimplefinProviderHost(claimUrl, 'SimpleFin claim URL');

  let res: Awaited<ReturnType<NetworkAPI['request']>>;
  try {
    res = await network.request({ url: claimUrl, method: 'POST' });
  } catch (err) {
    const approval = hostNotApprovedMessage(err);
    if (approval) throw new Error(`${approval} The setup token wasn't used, so paste the same token again.`);
    throw err;
  }
  if (res.status === 403) {
    // The one failure everyone hits once: a setup token can be claimed
    // exactly ONCE, and a second attempt (a retry, a reinstall, the token
    // reused from notes) gets a bare 403.
    throw new Error(
      'SimpleFin claim failed (403): this setup token was already used — each one can be claimed only once. '
      + 'Create a new setup token in SimpleFin Bridge and paste that. '
      + 'Note that creating a new token can disconnect any app still using the old one.',
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`SimpleFin claim failed: ${res.status}`);
  }
  const accessUrl = res.body.trim();
  requireHttps(accessUrl, 'SimpleFin access URL');
  requireSimplefinProviderHost(accessUrl, 'SimpleFin access URL');
  return accessUrl;
}

export async function fetchAccounts(
  accessUrl: string,
  startDate: Date,
  network: NetworkAPI,
  authSecretKey?: string,
): Promise<SimplefinAccountSet> {
  requireHttps(accessUrl, 'SimpleFin access URL');
  requireSimplefinProviderHost(accessUrl, 'SimpleFin access URL');

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

  // SDK 3.9's NetworkRequest has `timeoutSecs` (max 120); our SDK types (3.6.2)
  // lack it and older hosts ignore the unknown field. The bridge can be slow.
  const req: Parameters<NetworkAPI['request']>[0] & { timeoutSecs?: number } = {
    url: url.href,
    method: 'GET',
    timeoutSecs: 120,
  };
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
      hostNotApprovedMessage(err) ?? SIMPLEFIN_UNREACHABLE_MESSAGE,
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
  // Normalised, not cast: `errors` used to be trusted to exist (a bare `for…of`
  // downstream), and the structured `errlist` — which names the failing
  // connection — was ignored entirely. See shared/simplefin-payload.ts.
  return normalizeAccountSet(JSON.parse(res.body));
}
