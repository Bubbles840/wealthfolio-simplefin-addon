/**
 * The sqlite3-CLI fallback of the audits' reads (sqlite-audit.ts), driven
 * hermetically as sqlite-native-cli.test.ts drives the others: a file that is
 * not a database makes every node:sqlite open fail for real, and
 * `execFileSync` is mocked.
 *
 * The audits read EVERY row of the ledger, so their output can pass the
 * CLI's default 1 MB buffer on a real install; and the CLI prints one row per
 * line, so a note holding a newline would split its row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execFileSync: execFileSyncMock }));

const { AUDIT_CLI_MAX_BUFFER, getNativeAuditLedger, getNativeHeadlineRows, getNativeAuditSettings } = await import('./sqlite-audit.js');
const { getNativeTxSearchRows } = await import('./sqlite-native.js');

const made: string[] = [];
function notADatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-audit-cli-'));
  made.push(dir);
  const path = join(dir, 'wealthfolio.db');
  writeFileSync(path, 'this is not a sqlite database');
  return path;
}
const NEWLINE_SAFE_NOTES = "REPLACE(REPLACE(COALESCE(a.notes, ''), char(13), ' '), char(10), ' ')";

describe('the audits’ reads through the sqlite3 CLI', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    execFileSyncMock.mockReset();
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errors.mockRestore();
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('gives every audit query a 256 MB buffer — the whole ledger can pass the 1 MB default', () => {
    expect(AUDIT_CLI_MAX_BUFFER).toBe(256 * 1024 * 1024);
    execFileSyncMock.mockReturnValue('');
    const path = notADatabase();
    getNativeAuditLedger(path);
    getNativeHeadlineRows(path, '2026-10-01', '2026-11-01');
    getNativeAuditSettings(path);
    expect(execFileSyncMock.mock.calls.length).toBeGreaterThanOrEqual(6);
    for (const call of execFileSyncMock.mock.calls) expect(call[2]).toMatchObject({ maxBuffer: AUDIT_CLI_MAX_BUFFER });
  });

  it('leaves every other reader’s buffer as it was', () => {
    execFileSyncMock.mockReturnValue('');
    getNativeTxSearchRows(notADatabase());
    expect(execFileSyncMock).toHaveBeenCalled();
    for (const call of execFileSyncMock.mock.calls) expect(call[2]).not.toHaveProperty('maxBuffer');
  });

  it('turns a newline in a note into a space in SQL, so one row stays one line and keeps its tx id', () => {
    execFileSyncMock.mockReturnValue('');
    const path = notADatabase();
    getNativeAuditLedger(path);
    getNativeHeadlineRows(path, '2026-10-01', '2026-11-01');
    const queries = execFileSyncMock.mock.calls.map((c) => String((c[1] as string[]).at(-1)));
    expect(queries.filter((q) => q.includes('FROM activities a'))).toHaveLength(2);
    for (const q of queries.filter((q) => q.includes('FROM activities a'))) expect(q).toContain(NEWLINE_SAFE_NOTES);
    // What sqlite3 then prints for a note that held "LINE ONE\nLINE TWO": one line.
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValueOnce('wf-chk\x1fCASH\x1f0\x1f1\x1fPNC\n').mockReturnValueOnce(
      'act-1\x1fwf-chk\x1f2026-10-04\x1fUSD\x1fWITHDRAWAL\x1fWITHDRAWAL\x1fPOSTED\x1f500\x1f\x1f\x1f\x1f0\x1f\x1fLINE ONE LINE TWO · TRN-5\n',
    );
    const ledger = getNativeAuditLedger(path);
    expect(ledger.rows).toEqual([expect.objectContaining({ id: 'act-1', absCents: 500, notes: 'LINE ONE LINE TWO · TRN-5' })]);
  });
});
