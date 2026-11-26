/**
 * Helpers for replacing the SimpleFIN connection (token), shared by the
 * browser add-on and the Node companion. Imports nothing from either half.
 */
import { isSimplefinBridgeHost } from './simplefin-hosts.js';
import type { SyncHealth } from './telegram.js';

export const REFUSED_CONNECTION_LINE =
  'SimpleFIN no longer accepts this connection. Paste a new setup token in SimpleFin Sync → Settings → SimpleFIN connection; your mapping and rules stay.';

export const REFUSED_CONNECTION_SHORT =
  'SimpleFIN no longer accepts this connection. Replace the token to carry on; your mapping and rules stay.';

/**
 * Whether a failure means SimpleFIN refused the stored credentials (401/403 on
 * /accounts). An explicit `status` decides; else a numeric `status` on an
 * object; else the companion's error text. 402, claim failures and other
 * hosts' 403s never count.
 */
export function isRefusedConnection(errOrMessage: unknown, status?: number): boolean {
  const refused = (code: number) => code === 401 || code === 403;
  if (typeof status === 'number') return refused(status);
  if (errOrMessage && typeof errOrMessage === 'object') {
    const s = (errOrMessage as { status?: unknown }).status;
    if (typeof s === 'number') return refused(s);
  }
  let text: string | null = null;
  if (typeof errOrMessage === 'string') text = errOrMessage;
  else if (errOrMessage && typeof errOrMessage === 'object') {
    const m = (errOrMessage as { message?: unknown }).message;
    if (typeof m === 'string') text = m;
  }
  return text !== null && /\/accounts failed: 40[13]\b/.test(text);
}

/** A display name for the provider behind an access URL. Never reads credentials. */
export function providerName(accessUrl: string | null | undefined): string | null {
  if (!accessUrl) return null;
  let hostname: string;
  try {
    hostname = new URL(accessUrl).hostname;
  } catch {
    return null;
  }
  if (!hostname) return null;
  if (isSimplefinBridgeHost(hostname)) return 'SimpleFIN Bridge';
  const host = hostname.toLowerCase();
  if (host === 'lunchflow.app' || host.endsWith('.lunchflow.app')) return 'Lunch Flow';
  return hostname;
}

/** SimpleFIN account ids the setup relies on: non-empty mapping targets, then loan links, once each. */
export function mappedAccountIds(mapping: Record<string, string>, loanLinks?: Record<string, string>): string[] {
  const ids = new Set<string>();
  for (const [id, target] of Object.entries(mapping)) if (target) ids.add(id);
  for (const id of Object.keys(loanLinks ?? {})) ids.add(id);
  return [...ids];
}

/** Mapped ids that a new connection's account list lacks. */
export function missingMappedAccounts(
  mapping: Record<string, string>,
  accounts: readonly { id: string }[],
  loanLinks?: Record<string, string>,
): string[] {
  const present = new Set(accounts.map((a) => a.id));
  return mappedAccountIds(mapping, loanLinks).filter((id) => !present.has(id));
}

/**
 * Whether the companion's sync health shows a refused connection that no
 * replace has answered since its last failure.
 */
export function companionConnectionRefused(
  health: Pick<SyncHealth, 'firstFailedAt' | 'lastFailedAt' | 'lastError'> | null | undefined,
  replacedAt: string | null | undefined,
): boolean {
  if (!health || typeof health.firstFailedAt !== 'string' || typeof health.lastError !== 'string') return false;
  if (!isRefusedConnection(health.lastError)) return false;
  const replaced = Date.parse(replacedAt ?? '');
  const failed = Date.parse(health.lastFailedAt ?? health.firstFailedAt);
  return !(Number.isFinite(replaced) && replaced > failed);
}
