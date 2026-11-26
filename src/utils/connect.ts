import type { NetworkAPI } from '@wealthfolio/addon-sdk';
import { claimToken, fetchAccounts } from './simplefin';
import type { SecretsStore } from './secrets';
import { beginWrite, writeRefusal } from './write-lock';
import { directCallLine } from '../../shared/simplefin-budget';
import { isSimplefinNotice } from '../../shared/simplefin-payload';
import { connectionReplacedChange } from '../../shared/change-entries';
import { providerName, mappedAccountIds, missingMappedAccounts } from '../../shared/simplefin-connection';
import type { SimplefinAccount } from '../../shared/types';

export interface ClaimedToken { token: string; accessUrl: string }

/** A setup token can be claimed once, so a retry after a failed download
 *  reuses the access URL this token already gave; only a new token is claimed. */
export async function claimAccessUrl(
  pasted: string,
  network: NetworkAPI,
  previous: ClaimedToken | null,
): Promise<ClaimedToken> {
  const token = pasted.trim();
  if (previous?.token === token) return previous;
  return { token, accessUrl: await claimToken(token, network) };
}

/** base64(user:pass) of an access URL: the brokered request can only inject a
 *  secret as a Bearer value, so the add-on stores this pre-computed. */
export function credentialsB64(accessUrl: string): string {
  const parsedUrl = new URL(accessUrl);
  const credString = `${parsedUrl.username}:${parsedUrl.password}`;
  return btoa(
    encodeURIComponent(credString).replace(/%([0-9A-F]{2})/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    ),
  );
}

export type ReplaceStore = Pick<SecretsStore,
  'getAccessUrl' | 'setAccessUrl' | 'setAuthB64' | 'getNextAuthB64Key' | 'setNextAuthB64' | 'clearNextAuthB64'
  | 'setConnectionReplacedAt' | 'getAccountNames' | 'setAccountNames' | 'getAccountMapping'>
  & Partial<Pick<SecretsStore, 'getLoanLinks' | 'recordChange' | 'getSimplefinRequests' | 'setSimplefinRequests'>>;

export interface ReplacedConnection {
  kind: 'replaced';
  provider: string;
  message: string;
  accounts: SimplefinAccount[];
  feedErrors: string[];
  hadErrors: boolean;
  missing: string[];
}
export type ReplaceOutcome = ReplacedConnection | { kind: 'failed'; message: string };

export function notListedMessage(reason: string): string {
  return `The token was accepted, but SimpleFIN didn't list any accounts: ${reason.replace(/\.$/, '')}. `
    + 'Your current connection is unchanged. Press Connect to try again: the same token works while this page stays open.';
}

export function replacedMessage(provider: string, mappedCount: number, missingNames: string[]): string {
  const head = `✓ Connected through ${provider}.`;
  if (missingNames.length === 1) {
    return `${head} 1 mapped account isn't in this connection: ${missingNames[0]}. If your bank lists it under a new name, map it in the Accounts card above.`;
  }
  if (missingNames.length > 1) {
    return `${head} ${missingNames.length} mapped accounts aren't in this connection: ${missingNames.join(', ')}. If your bank lists them under new names, map them in the Accounts card above.`;
  }
  if (mappedCount === 0) return `${head} The next sync uses it.`;
  if (mappedCount === 1) return `${head} Your mapped account is in this connection. The next sync uses it.`;
  return `${head} All ${mappedCount} mapped accounts are in this connection. The next sync uses it.`;
}

const failed = (message: string): ReplaceOutcome => ({ kind: 'failed', message });
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** A read that may fail must not stop a replace the new token already passed. */
async function tolerate<T>(read: (() => Promise<T>) | undefined, fallback: T): Promise<T> {
  try { return read ? await read() : fallback; } catch { return fallback; }
}

/**
 * Replace the SimpleFIN connection with a new token, keeping the mapping,
 * rules and names. The ORDER is the guard: nothing but the temporary
 * credentials is written until the new token has listed at least one account,
 * so a failed replace leaves a working setup exactly as it was.
 */
export async function replaceConnection(
  pasted: string,
  claimed: { current: ClaimedToken | null },
  deps: { store: ReplaceStore; network: NetworkAPI },
): Promise<ReplaceOutcome> {
  const { store, network } = deps;
  const release = beginWrite();
  if (!release) return failed(writeRefusal('remove'));
  try {
    const line = await directCallLine(store, 'setup');
    if (line) return failed(line);

    let url: string;
    try {
      claimed.current = await claimAccessUrl(pasted, network, claimed.current);
      url = claimed.current.accessUrl;
    } catch (e) {
      return failed(messageOf(e));
    }

    const b64 = credentialsB64(url);
    let set: Awaited<ReturnType<typeof fetchAccounts>>;
    try {
      await store.setNextAuthB64(b64);
      set = await fetchAccounts(url, new Date(Date.now() - 86_400_000), network, await store.getNextAuthB64Key());
    } catch (e) {
      store.clearNextAuthB64().catch(() => {});
      return failed(notListedMessage(messageOf(e)));
    }
    if (set.accounts.length === 0) {
      store.clearNextAuthB64().catch(() => {});
      return failed(notListedMessage(set.errors.join('; ') || 'the account list was empty'));
    }

    const fromProvider = providerName(await tolerate(() => store.getAccessUrl(), null));
    const names = await tolerate(() => store.getAccountNames(), {} as Record<string, string>);
    const mapping = (await tolerate(() => store.getAccountMapping(), null)) ?? {};
    const loanLinks = await tolerate(store.getLoanLinks?.bind(store), undefined);

    await store.setAccessUrl(url);
    await store.setAuthB64(b64);
    await store.clearNextAuthB64().catch(() => {});
    await store.setConnectionReplacedAt(new Date().toISOString()).catch(() => {});
    await store.setAccountNames({ ...names, ...Object.fromEntries(set.accounts.map((a) => [a.id, a.name])) }).catch(() => {});
    const provider = providerName(url) ?? 'SimpleFIN';
    await Promise.resolve(store.recordChange?.(connectionReplacedChange({ fromProvider, toProvider: provider }))).catch(() => {});

    const missing = missingMappedAccounts(mapping, set.accounts, loanLinks);
    const missingNames = missing.map((id) => names[id] ?? id);
    return {
      kind: 'replaced',
      provider,
      message: replacedMessage(provider, mappedAccountIds(mapping, loanLinks).length, missingNames),
      accounts: set.accounts,
      feedErrors: set.errors,
      hadErrors: set.errors.some((e) => !isSimplefinNotice(e)),
      missing,
    };
  } finally {
    release();
  }
}
