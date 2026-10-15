/**
 * companion/src/live-db.ts
 *
 * The one way a WRITER opens Wealthfolio's database to decide what to write.
 * Live only: `mode=ro`, then `mode=ro&readonly_shm=1`. There is deliberately no
 * `immutable=1` rung: that reads the main file alone, ignoring the write-ahead
 * log — a snapshot that can be a checkpoint behind what Wealthfolio serves, so
 * a decision made from it (a filing, a settings list written back whole) can
 * overwrite what the person or another writer just did. A reader that only
 * displays may take a snapshot; a writer waits (null).
 */
import { existsSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';

/** True when there is a file at the path (so a null from `openLiveDatabase` means "snapshot only"). */
export const databaseFileExists = (dbPath: string): boolean => !!dbPath && existsSync(dbPath);

/**
 * Why `openLiveDatabase` returned null, for the log line only — never to decide
 * a write. 'snapshot': a real database that only an immutable read can open
 * (a file-only mount: no -wal/-shm). 'unreadable': not a database at all.
 */
export function whyNoLiveOpen(dbPath: string): 'snapshot' | 'unreadable' {
  try {
    const db = new DatabaseSync(`file:${dbPath}?immutable=1`);
    try {
      db.prepare('SELECT count(*) FROM sqlite_master').get();
      return 'snapshot';
    } finally {
      db.close();
    }
  } catch {
    return 'unreadable';
  }
}

/** Opens the database read-only and live, or null when only a snapshot is possible. */
export function openLiveDatabase(dbPath: string): DatabaseSync | null {
  if (!databaseFileExists(dbPath)) return null;
  for (const uri of [`file:${dbPath}?mode=ro`, `file:${dbPath}?mode=ro&readonly_shm=1`]) {
    try {
      const db = new DatabaseSync(uri);
      // Reads the file itself: `SELECT 1` would succeed on anything.
      db.prepare('SELECT count(*) FROM sqlite_master').get();
      return db;
    } catch {
      /* next form */
    }
  }
  return null;
}
