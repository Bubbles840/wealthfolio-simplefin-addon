/**
 * companion/src/uncategorized-status.ts
 *
 * Publishes the "needs a category" count for the addon's Overview tile.
 */
import { UNCATEGORIZED_STATUS_SECRET_KEY } from '../../shared/status-keys.js';

/** Last 90 days, end-exclusive tomorrow — matches the sweep's half-open bounds. */
export function uncategorizedWindow(now: Date): { start: string; end: string } {
  const day = 24 * 60 * 60 * 1000;
  const start = new Date(now.getTime() - 90 * day).toISOString().slice(0, 10);
  const end = new Date(now.getTime() + day).toISOString().slice(0, 10);
  return { start, end };
}

/**
 * Publish the needs-a-category count for the Overview tile.
 *
 * The addon cannot compute this itself — the SDK exposes no category data — so
 * the companion, which already reads the database for the import-notice sweep,
 * publishes it each sync. Dependency-injected and swallow-all because a stats
 * tile must never be able to fail a sync: the worst outcome of a broken publish
 * is a hidden tile, which is also its off state.
 */
export async function publishUncategorizedStatus(
  setSecret: (key: string, value: string) => Promise<void>,
  readCount: () => number,
  now: Date = new Date(),
): Promise<void> {
  try {
    const status = { count: readCount(), asOf: now.toISOString() };
    await setSecret(UNCATEGORIZED_STATUS_SECRET_KEY, JSON.stringify(status));
  } catch {
    // Deliberate: see doc comment.
  }
}
