/**
 * companion/src/date-repair-reads.ts
 *
 * The date repair's database reads: LIVE only (live-db.ts). It decides which
 * rows to write from what it reads, and a snapshot can be a checkpoint behind
 * Wealthfolio — rows the 1.61 sync wrote since are missing from it, and the
 * repair would take them for retyped and finish with them still at midnight.
 * When only a snapshot is possible these throw `SnapshotOnlyError` and the
 * repair waits.
 */
import { SnapshotOnlyError } from './date-repair.js';
import { openLiveDatabase, whyNoLiveOpen } from './live-db.js';

function withLiveDatabase<T>(dbPath: string, read: (db: NonNullable<ReturnType<typeof openLiveDatabase>>) => T): T {
  const db = openLiveDatabase(dbPath);
  if (!db) {
    if (whyNoLiveOpen(dbPath) === 'snapshot') throw new SnapshotOnlyError();
    throw new Error("couldn't read the database");
  }
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** Every row's STORED `activity_type`, by id. */
export function liveStoredActivityTypes(dbPath: string): Map<string, string> {
  return withLiveDatabase(dbPath, (db) => {
    const rows = db.prepare(`SELECT a.id AS id, COALESCE(a.activity_type, '') AS t FROM activities a`).all() as Array<{ id: string; t: string }>;
    return new Map(rows.map((r) => [String(r.id), String(r.t)]));
  });
}

/** Ids of every row with a non-blank `activity_type_override`. */
export function liveOverriddenActivityIds(dbPath: string): Set<string> {
  return withLiveDatabase(dbPath, (db) => {
    const rows = db.prepare(`SELECT a.id AS id FROM activities a WHERE TRIM(COALESCE(a.activity_type_override, '')) <> ''`).all() as Array<{ id: string }>;
    return new Set(rows.map((r) => String(r.id)));
  });
}

/** Wealthfolio's timezone setting; null when unset. */
export function liveTimeZone(dbPath: string): string | null {
  return withLiveDatabase(dbPath, (db) => {
    const r = db.prepare(`SELECT setting_value AS v FROM app_settings WHERE setting_key = 'timezone'`).get() as { v: string } | undefined;
    return r?.v?.trim() || null;
  });
}
