/**
 * Wealthfolio's rule for an add-on secret key (upstream
 * crates/core/src/secrets/mod.rs, `normalize_addon_secret_key`, every version
 * since 3.6.0): 1 to 128 characters, ASCII letters, digits, '.', '_' and '-'.
 * The server answers any other key with a 400, on get, set and delete alike.
 * Test doubles of the secrets API call this, so a key the real host refuses
 * fails in the suite instead of on a live server.
 */
export function requireWealthfolioSecretKey(key: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(key)) {
    throw new Error(`400 - Addon secret key may only contain ASCII letters, digits, '.', '_' and '-' (got ${JSON.stringify(key)})`);
  }
}
