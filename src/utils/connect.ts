import type { NetworkAPI } from '@wealthfolio/addon-sdk';
import { claimToken, fetchAccounts } from './simplefin';
import type { SecretsStore } from './secrets';
import { beginWrite, writeRefusal } from './write-lock';
import { directCallLine } from '../../shared/simplefin-budget';
import { isSimplefinNotice } from '../../shared/simplefin-payload';
import { connectionReplacedChange } from '../../shared/change-entries';
import { isRefusedConnection, providerName, mappedAccountIds, missingMappedAccounts } from '../../shared/simplefin-connection';
import type { SimplefinAccount } from '../../shared/types';

export interface ClaimedToken { token: string; accessUrl: string }

/**
 * The Settings card's claim, held for the page's life rather than the card's:
 * the card unmounts when it is collapsed or the tab changes, and a setup token
 * can be claimed only once, so a retry with the same token must find it here.
 * `replaceConnection` clears it after a swap, and when SimpleFIN refuses the
 * connection the claim gave.
 */
export const replaceClaim: { current: ClaimedToken | null } = { current: null };

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
/** The new connection lists none of the mapped accounts: nothing is swapped until the person says so. */
export interface ConfirmReplace { kind: 'confirm'; provider: string; message: string }
export type ReplaceOutcome = ReplacedConnection | ConfirmReplace | { kind: 'failed'; message: string };

export function notListedMessage(reason: string): string {
  return `The token was accepted, but SimpleFIN didn't list any accounts: ${reason.replace(/\.$/, '')}. `
    + 'Your current connection is unchanged. Press Connect to try again: the same token works while this page stays open.';
}

/** SimpleFIN refused the claimed connection itself (401/403): retrying it can't help. */
export function newTokenRefusedMessage(reason: string): string {
  return `SimpleFIN refused the new token's connection: ${reason.replace(/\.$/, '')}. `
    + 'Your current connection is unchanged. Make a new setup token in SimpleFIN Bridge or Lunch Flow and paste that.';
}

export function noneMappedMessage(provider: string, mappedCount: number): string {
  if (mappedCount === 1) {
    return `Your mapped account isn't in this ${provider} connection. If you're moving to another SimpleFIN account or provider, press Connect anyway and map it next. Otherwise your current connection stays as it is.`;
  }
  return `None of your ${mappedCount} mapped accounts are in this ${provider} connection. If you're moving to another SimpleFIN account or provider, press Connect anyway and map the accounts next. Otherwise your current connection stays as it is.`;
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
 *
 * A new connection that lists none of the mapped accounts is most likely the
 * wrong SimpleFIN account, so it returns `confirm` and writes nothing; the
 * person's `confirmed: true` press reuses the claim and swaps.
 */
export async function replaceConnection(
  pasted: string,
  claimed: { current: ClaimedToken | null },
  deps: { store: ReplaceStore; network: NetworkAPI },
  opts?: { confirmed?: boolean },
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
    // The test download's failures all leave the working connection alone.
    const notListed = async (reason: string): Promise<ReplaceOutcome> => {
      await store.clearNextAuthB64().catch(() => {});
      return failed(notListedMessage(reason));
    };
    try {
      await store.setNextAuthB64(b64);
    } catch (e) {
      await store.clearNextAuthB64().catch(() => {});
      return failed(
        `Couldn't save the new token's details in Wealthfolio: ${messageOf(e).replace(/\.$/, '')}. Your current connection is unchanged.`,
      );
    }
    let set: Awaited<ReturnType<typeof fetchAccounts>>;
    try {
      set = await fetchAccounts(url, new Date(Date.now() - 86_400_000), network, await store.getNextAuthB64Key());
    } catch (e) {
      if (isRefusedConnection(e)) {
        // The claimed URL itself is refused: a retry would only be refused again.
        claimed.current = null;
        await store.clearNextAuthB64().catch(() => {});
        return failed(newTokenRefusedMessage(messageOf(e)));
      }
      return notListed(messageOf(e));
    }
    if (set.accounts.length === 0) return notListed(set.errors.join('; ') || 'the account list was empty');

    const mapping = (await tolerate(() => store.getAccountMapping(), null)) ?? {};
    const loanLinks = await tolerate(store.getLoanLinks?.bind(store), undefined);
    const mappedCount = mappedAccountIds(mapping, loanLinks).length;
    const missing = missingMappedAccounts(mapping, set.accounts, loanLinks);
    const provider = providerName(url) ?? 'SimpleFIN';
    if (!opts?.confirmed && mappedCount > 0 && missing.length === mappedCount) {
      await store.clearNextAuthB64().catch(() => {});
      return { kind: 'confirm', provider, message: noneMappedMessage(provider, mappedCount) };
    }

    const oldUrl = await tolerate(() => store.getAccessUrl(), null);
    const fromProvider = providerName(oldUrl);
    const names = await tolerate<Record<string, string> | null>(() => store.getAccountNames(), null);

    try {
      await store.setAccessUrl(url);
    } catch (e) {
      await store.clearNextAuthB64().catch(() => {});
      throw e;
    }
    try {
      await store.setAuthB64(b64);
    } catch (e) {
      // The new URL must not sit beside the old credentials: put the old one back.
      if (oldUrl) await store.setAccessUrl(oldUrl).catch(() => {});
      await store.clearNextAuthB64().catch(() => {});
      throw e;
    }
    await store.clearNextAuthB64().catch(() => {});
    claimed.current = null;
    await store.setConnectionReplacedAt(new Date().toISOString()).catch(() => {});
    // A names read that failed must not turn this merge into a wholesale replace.
    if (names) {
      await store.setAccountNames({ ...names, ...Object.fromEntries(set.accounts.map((a) => [a.id, a.name])) }).catch(() => {});
    }
    await Promise.resolve(store.recordChange?.(connectionReplacedChange({ fromProvider, toProvider: provider }))).catch(() => {});

    const missingNames = missing.map((id) => names?.[id] ?? id);
    return {
      kind: 'replaced',
      provider,
      message: replacedMessage(provider, mappedCount, missingNames),
      accounts: set.accounts,
      feedErrors: set.errors,
      hadErrors: set.errors.some((e) => !isSimplefinNotice(e)),
      missing,
    };
  } finally {
    release();
  }
}
