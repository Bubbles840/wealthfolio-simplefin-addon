/**
 * companion/src/uncategorized-status.ts
 *
 * Publishes the "needs a category" count for the addon's Overview tile.
 */
import { existsSync } from 'fs';
import { UNCATEGORIZED_STATUS_SECRET_KEY } from '../../shared/status-keys.js';

/**
 * Last 90 days, end-exclusive tomorrow — half-open bounds like the
 * import-notice sweep's (`UNCATEGORIZED_SWEEP_DAYS` in index.ts), but
 * deliberately a wider span: the sweep is a per-sync nag that only needs to
 * catch what's recent, while this tile is a standing backlog count, so it
 * looks back further. The two numbers are expected to disagree.
 */
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

/**
 * Guarded entry point for the sync flow: only publish when there is an actual
 * database file to count from.
 *
 * A `dbPath` that's unset or points nowhere (moved DB, misconfigured env,
 * container mount not yet attached) must skip the publish rather than call
 * `countUncategorized` — that function returns `[]`/`0` for a missing file
 * rather than throwing, so without this check a stale path would publish a
 * confident `count: 0`, i.e. "nothing needs a category", which is false
 * rather than unknown. `existsSync` is the same check
 * `getNativeUncategorizedSpending` itself opens with, so this mirrors what
 * the reader would have done anyway — just before, not after, the read.
 */
export async function publishUncategorizedStatusForDbPath(
  dbPath: string,
  setSecret: (key: string, value: string) => Promise<void>,
  countUncategorized: (dbPath: string, startInclusive: string, endExclusive: string) => number,
  now: Date = new Date(),
): Promise<void> {
  if (!dbPath || !existsSync(dbPath)) return;
  const { start, end } = uncategorizedWindow(now);
  await publishUncategorizedStatus(setSecret, () => countUncategorized(dbPath, start, end), now);
}
