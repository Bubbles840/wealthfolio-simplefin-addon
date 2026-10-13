/**
 * shared/handle.ts
 *
 * A short, stable handle for a key, for `callback_data`.
 *
 * Telegram caps callback data at 64 bytes, and a key can carry a uuid plus an
 * account name. FNV-1a over the key gives 8 hex characters; a tap resolves the
 * handle by re-judging what it points at and hashing each key, so nothing has
 * to be remembered between a message going out and the tap arriving — which
 * can be hours, and a container restart, later. A leaf module (no imports) so
 * the subscription roster can use it without an import cycle through
 * shared/telegram.ts.
 */
export function findingHandle(key: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
