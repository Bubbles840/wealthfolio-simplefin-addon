/**
 * companion/src/installed-addon.ts
 *
 * Which build of the addon is actually INSTALLED, read off disk.
 *
 * Why the companion needs this when the addon already reports its own version:
 * the addon writes `addon_version` when its bundle LOADS in a browser, so that
 * secret means "the newest build that has ever run" — and a Wealthfolio tab
 * pinned open for a week keeps it stale however many zips are uploaded
 * underneath it. The daily report's skew warning therefore could not tell "you
 * never uploaded the zip" from "you did, and your tab is old", offered both
 * remedies at once, and twice read as a false alarm (2026-09-06, 2026-09-20).
 *
 * Wealthfolio unpacks installed addons into `<data dir>/addons/<folder>/`, and
 * the companion already mounts that data directory read-only to reach the
 * database — the DIRECTORY, not the bare .db file, which it needs anyway for
 * the write-ahead log. So the manifest is one `readFileSync` away and settles
 * which remedy applies.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

const ADDON_ID = 'simplefin-sync';

/**
 * The installed addon's manifest version, or `null` when it cannot be known.
 *
 * `null` is deliberately broad — no addons directory, no matching manifest, an
 * unparseable one, a manifest with no version — because every one of those
 * means the same thing to the caller: there is no on-disk evidence, so fall
 * back to the older both-remedies warning. Nothing here throws, since this runs
 * inside the daily report and a missing mount must never cost the user the rest
 * of it.
 *
 * Matched on the manifest's `id`, not the folder name: the host chooses the
 * folder, and nothing promises it equals the addon id.
 */
export function readInstalledAddonVersion(dbPath: string): string | null {
  try {
    const addonsDir = join(dirname(dbPath), 'addons');
    if (!existsSync(addonsDir)) return null;
    for (const entry of readdirSync(addonsDir)) {
      const manifestPath = join(addonsDir, entry, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { id?: unknown; version?: unknown };
        if (manifest.id !== ADDON_ID) continue;
        return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : null;
      } catch {
        // An unreadable manifest is simply not evidence; keep looking.
      }
    }
    return null;
  } catch {
    return null;
  }
}
