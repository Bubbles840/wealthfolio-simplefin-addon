/**
 * companion/src/uncategorized-status.ts
 *
 * Publishes the "needs a category" count and row list for the addon's
 * Overview tile.
 */
import { existsSync } from 'fs';
import { UNCATEGORIZED_STATUS_SECRET_KEY } from '../../shared/status-keys.js';
import {
  DismissalLedger,
  UncategorizedRow,
  UNCATEGORIZED_ROWS_CAP,
  visibleUncategorized,
} from '../../shared/uncategorized.js';
import { descriptionFromComment } from '../../shared/sync-core.js';

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

/** The minimal shape `publishUncategorizedStatus` needs from a native row —
 *  `getNativeUncategorizedSpending`'s `NativeUncategorizedTx` satisfies this,
 *  but this file does not depend on `sqlite-native.ts` to say so. */
interface UncategorizedSourceRow {
  activityId: string;
  /** Raw stored note (`<description> · <txId>[ · pending]`); stripped below
   *  with `descriptionFromComment` before it is published. */
  notes: string;
  amountCents: number;
  date: string;
  accountName: string;
}

/**
 * Publish the needs-a-category count AND the row list for the Overview tile.
 *
 * The addon cannot compute either itself — the SDK exposes no category data —
 * so the companion, which already reads the database for the import-notice
 * sweep, publishes both each sync. Dependency-injected and swallow-all
 * because a stats tile must never be able to fail a sync: the worst outcome
 * of a broken publish is a hidden or stale tile, which is also its off state.
 */
export async function publishUncategorizedStatus(
  setSecret: (key: string, value: string) => Promise<void>,
  readRows: () => UncategorizedSourceRow[],
  readLedger: () => Promise<DismissalLedger>,
  now: Date = new Date(),
): Promise<void> {
  try {
    const ledger = await readLedger();
    const visible = visibleUncategorized(readRows(), ledger);
    const rows: UncategorizedRow[] = visible.slice(0, UNCATEGORIZED_ROWS_CAP).map((r) => ({
      activityId: r.activityId,
      date: r.date,
      amountCents: r.amountCents,
      // The stored note carries ` · <txId>` and possibly ` · pending`; the
      // addon renders this string, so strip the bookkeeping first. A blank
      // strip result (a legitimately empty SimpleFin description) falls back
      // to the raw note rather than publishing an empty field.
      description: descriptionFromComment(r.notes) || r.notes,
      accountName: r.accountName,
    }));
    const status = {
      // The true total AFTER dismissal filtering — NOT `rows.length`, which is
      // capped below. A truncated list must never make the tile understate
      // the real backlog.
      count: visible.length,
      asOf: now.toISOString(),
      // Capped: see UNCATEGORIZED_ROWS_CAP.
      rows,
    };
    await setSecret(UNCATEGORIZED_STATUS_SECRET_KEY, JSON.stringify(status));
  } catch {
    // Deliberate: see doc comment.
  }
}

/**
 * Guarded entry point for the sync flow: only publish when there is an actual
 * database file to read from.
 *
 * A `dbPath` that's unset or points nowhere (moved DB, misconfigured env,
 * container mount not yet attached) must skip the publish rather than call
 * `readRows` — that function returns `[]` for a missing file rather than
 * throwing, so without this check a stale path would publish a confident
 * `count: 0`, i.e. "nothing needs a category", which is false rather than
 * unknown. `existsSync` is the same check `getNativeUncategorizedSpending`
 * itself opens with, so this mirrors what the reader would have done anyway —
 * just before, not after, the read.
 */
export async function publishUncategorizedStatusForDbPath(
  dbPath: string,
  setSecret: (key: string, value: string) => Promise<void>,
  readRows: (
    dbPath: string,
    startInclusive: string,
    endExclusive: string,
  ) => UncategorizedSourceRow[],
  readLedger: () => Promise<DismissalLedger>,
  now: Date = new Date(),
): Promise<void> {
  if (!dbPath || !existsSync(dbPath)) return;
  const { start, end } = uncategorizedWindow(now);
  await publishUncategorizedStatus(setSecret, () => readRows(dbPath, start, end), readLedger, now);
}
