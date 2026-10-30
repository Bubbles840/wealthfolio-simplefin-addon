/**
 * companion/src/profile-id.ts
 *
 * `WEALTHFOLIO_PROFILE_ID` (#50). The ID ends up in a file path
 * (`profiles/<id>/app.db`) and in a request body, so anything that is not a
 * UUID is refused here, before either; a stray `../` or a newline never gets
 * that far. Lowercased, as Wealthfolio names its folders and compares IDs.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID.test(value);

export const PROFILE_ID_FORMAT =
  'WEALTHFOLIO_PROFILE_ID must be a profile ID, like 1b4e28ba-2fa1-41d2-883f-0016d3cca427 (profiles.json in Wealthfolio\'s data folder lists them).';

/** The profile to sync, or `null` when none is set. Throws on a malformed ID. */
export function profileIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.WEALTHFOLIO_PROFILE_ID ?? '').trim();
  if (!raw) return null;
  if (!isUuid(raw)) throw new Error(PROFILE_ID_FORMAT);
  return raw.toLowerCase();
}
