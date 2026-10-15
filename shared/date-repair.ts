/**
 * shared/date-repair.ts
 *
 * The one-time repair of 1.62 (ruling W2): rows Wealthfolio stored at exactly
 * 00:00 UTC — every bank row the sync wrote as a bare date on 3.8 and 3.9 —
 * move to 12:00 UTC on the same date, the instant new rows are written at
 * (shared/bank-day.ts). West of UTC a midnight-UTC row is the previous
 * evening, so Wealthfolio's Spending page counted a row dated the 1st in the
 * month before.
 *
 * Which rows: in an account the add-on maps (`account_mapping`), stored at
 * exactly 00:00:00 UTC in any of the forms Wealthfolio returns — a bare date,
 * `…T00:00:00Z`, `…T00:00:00+00:00` — and:
 *  - NOT in a group: Wealthfolio copies an updated leg's note and date onto
 *    its partner, and a linked transfer is never spending anyway;
 *  - NOT carrying a type override: Wealthfolio's search answers the EFFECTIVE
 *    type, and an update writes the type it is sent as the stored one.
 * Nothing at any other instant is touched.
 *
 * The write is date-only. Wealthfolio's update (3.8–3.10, storage-sqlite
 * activities repository `update_activity`) keeps what it is not sent — the
 * asset, the amount, fee and quantity, the subtype, the metadata, the status,
 * the review flag, the type override and the group — and category filings
 * live in their own table; a date change leaves split lines alone
 * (`activity_update_invalidates_spending_splits`). Two fields are not patches:
 * the type and currency are required, and the NOTE is written as sent (an
 * update without one clears it), so the write carries the row's own.
 *
 * The companion runs it (companion/src/date-repair.ts) after a sync, in
 * batches, and records it done in an add-on secret only when every row moved,
 * so an interrupted run is picked up by the next sync: a moved row is no
 * longer at midnight.
 */
import { bankDayInstant } from './bank-day.js';
import { localDay } from './wf-spending.js';
import type { ActivityWrite } from './sync-host.js';

/** The first add-on release that writes bank rows at noon. Before it, a 1.61 add-on keeps writing midnight rows (3.8/3.9), so a repair run first would be undone. */
export const DATE_REPAIR_SINCE = '1.62.0';
/** Add-on secret: present once every row has been moved. */
export const DATE_REPAIR_SECRET_KEY = 'date_repair_done';
/** Rows per write. */
export const DATE_REPAIR_BATCH = 25;
/** The pause between batches, in ms: Wealthfolio recalculates after each write. */
export const DATE_REPAIR_PAUSE_MS = 500;

// A bare date, or 00:00:00 with Z, +00:00 or no offset at all (upstream reads a naive time as UTC).
const MIDNIGHT = /^(\d{4}-\d{2}-\d{2})(?:[T ]00:00:00(?:\.0+)?(?:Z|\+00:00)?)?$/;

/** The day of a date stored at exactly 00:00:00 UTC, or null. */
export function utcMidnightDay(stored: string): string | null {
  const m = MIDNIGHT.exec(stored.trim());
  return m ? m[1] : null;
}

/** One row as Wealthfolio's search returns it. */
export interface DateRepairRow {
  id: string;
  accountId: string;
  /** The stored date, as returned. */
  date: string;
  /** The type the search returns: the effective one. */
  activityType: string;
  currency: string;
  /** The note; null when the row has none. */
  comment: string | null;
  /** The link group; null or '' when none. Absent (undefined) is unknown, and counts as grouped. */
  sourceGroupId: string | null | undefined;
}

/** An update whose note may be null (clears it; upstream's `notes` is optional). */
export type DateRepairWrite = Omit<ActivityWrite, 'comment'> & { comment: string | null };

export interface DateRepairPlan {
  moves: Array<{ row: DateRepairRow; write: DateRepairWrite }>;
  /** At midnight UTC, left alone: in a group. */
  skippedGrouped: number;
  /** At midnight UTC, left alone: a type override. */
  skippedOverride: number;
  /** At midnight UTC, not decided: the database does not know the row's stored type (it is newer than the read). Never counted as retyped, and the repair is not done while any is left. */
  unknown: number;
}

/** The date-only update that moves one row to noon UTC on its day. */
export function dateRepairWrite(row: DateRepairRow, day: string): DateRepairWrite {
  return {
    id: row.id,
    accountId: row.accountId,
    activityType: row.activityType,
    activityDate: bankDayInstant(day),
    currency: row.currency,
    // Wealthfolio's update takes the note as sent (null clears it, as a missing one does).
    comment: row.comment ?? null,
  };
}

export function planDateRepair(
  rows: readonly DateRepairRow[],
  opts: {
    mappedAccountIds: ReadonlySet<string>;
    overriddenIds: ReadonlySet<string>;
    /** Each row's STORED type, from the database. When given, a row is moved only if its stored type equals the search's (effective) one: a blank override or a stale read is left alone. */
    storedTypes?: ReadonlyMap<string, string>;
    /** Wealthfolio's timezone (null: the process's own). When given, a row moves only if noon UTC on its day is that same day there: east of UTC+11 a midnight-UTC row is ALREADY on the bank's day and noon would push it into the next one. */
    timeZone?: string | null;
  },
): DateRepairPlan {
  const plan: DateRepairPlan = { moves: [], skippedGrouped: 0, skippedOverride: 0, unknown: 0 };
  for (const row of rows) {
    if (!opts.mappedAccountIds.has(row.accountId)) continue;
    const day = utcMidnightDay(row.date);
    if (!day) continue;
    if (row.sourceGroupId !== null && row.sourceGroupId !== '') {
      plan.skippedGrouped += 1;
      continue;
    }
    if (opts.storedTypes && !opts.storedTypes.has(row.id)) {
      plan.unknown += 1;
      continue;
    }
    if (opts.overriddenIds.has(row.id) || (opts.storedTypes && opts.storedTypes.get(row.id) !== row.activityType)) {
      plan.skippedOverride += 1;
      continue;
    }
    if (opts.timeZone !== undefined && localDay(bankDayInstant(day), opts.timeZone) !== day) continue;
    plan.moves.push({ row, write: dateRepairWrite(row, day) });
  }
  return plan;
}

/** `[a, b, c, d, e]` in twos: `[[a, b], [c, d], [e]]`. */
export function batches<T>(items: readonly T[], size = DATE_REPAIR_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** What the done-marker records. */
export interface DateRepairMarker {
  at: string;
  moved: number;
  skippedGrouped: number;
  skippedOverride: number;
}

/** The stored marker, or null when there is none or it cannot be read — the
 *  repair then runs again, which only ever moves rows still at midnight. */
export function parseDateRepairMarker(raw: string | null | undefined): DateRepairMarker | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const m = v as Record<string, unknown>;
    if (typeof m.at !== 'string' || typeof m.moved !== 'number') return null;
    return {
      at: m.at, moved: m.moved,
      skippedGrouped: typeof m.skippedGrouped === 'number' ? m.skippedGrouped : 0,
      skippedOverride: typeof m.skippedOverride === 'number' ? m.skippedOverride : 0,
    };
  } catch {
    return null;
  }
}
