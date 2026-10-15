import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SnapshotOnlyError } from './date-repair.js';
import { liveOverriddenActivityIds, liveStoredActivityTypes, liveTimeZone } from './date-repair-reads.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) { try { chmodSync(d, 0o755); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); } });

function database(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-drr-'));
  made.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE activities (id TEXT PRIMARY KEY, activity_type TEXT, activity_type_override TEXT);
    CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT);
    INSERT INTO activities VALUES ('a', 'WITHDRAWAL', NULL), ('o', 'WITHDRAWAL', 'DEPOSIT'), ('b', 'DEPOSIT', '  ');
    INSERT INTO app_settings VALUES ('timezone', 'America/New_York');
  `);
  db.close();
  return path;
}

describe('the date repair’s live reads (I1)', () => {
  it('reads the stored types, the non-blank overrides and the timezone', () => {
    const path = database();
    expect([...liveStoredActivityTypes(path)]).toEqual(expect.arrayContaining([['a', 'WITHDRAWAL'], ['o', 'WITHDRAWAL'], ['b', 'DEPOSIT']]));
    expect([...liveOverriddenActivityIds(path)]).toEqual(['o']);
    expect(liveTimeZone(path)).toBe('America/New_York');
  });

  it('on a mount where only a snapshot is possible (a WAL database, 0555 directory, no -wal/-shm) every read says so — no immutable fallback', () => {
    const path = database();
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode=WAL;');
    db.close();
    chmodSync(join(path, '..'), 0o555);
    expect(() => liveStoredActivityTypes(path)).toThrow(SnapshotOnlyError);
    expect(() => liveOverriddenActivityIds(path)).toThrow(SnapshotOnlyError);
    expect(() => liveTimeZone(path)).toThrow(SnapshotOnlyError);
  });

  it('a missing file is an ordinary read failure, not a snapshot', () => {
    const missing = join(tmpdir(), 'sfin-drr-definitely-missing', 'wealthfolio.db');
    expect(() => liveStoredActivityTypes(missing)).toThrow("couldn't read the database");
    expect(() => liveStoredActivityTypes(missing)).not.toThrow(SnapshotOnlyError);
  });
});
