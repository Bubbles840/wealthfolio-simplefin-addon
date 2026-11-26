import type { NetworkAPI } from '@wealthfolio/addon-sdk';
import { claimToken } from './simplefin';

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
