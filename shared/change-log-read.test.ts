import { describe, it, expect, vi } from 'vitest';
import { categoryFiledChange, importChange, stampChange, type ChangeEntry, type ChangeWriter } from './change-entries.js';
import { readChangeLog, type ChangeBucket } from './change-log.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-12T14:05:00Z');
const CHECKING = { sfinId: 'ACT-1f2e', wfId: 'wf-checking', name: 'Checking' };

const entryAt = (writer: ChangeWriter, at: string, n: number): ChangeEntry => stampChange(importChange({
  account: CHECKING, txKey: accountTxKey('ACT-1f2e', `TRN-${n}`), activityId: `act-${n}`, description: `KROGER #${n}`,
  amountCents: -100, date: at.slice(0, 10), pending: false, activityType: 'WITHDRAWAL',
}), writer, new Date(at), 'r');

const bucket = (writer: ChangeWriter, month: string, entries: ChangeEntry[], extra: Partial<ChangeBucket> = {}) =>
  JSON.stringify({ v: 1, writer, month, entries, gaps: [], ...extra });

const reader = (data: Record<string, string>) => vi.fn(async (k: string) => data[k] ?? null);

describe('readChangeLog', () => {
  it('merges both writers newest first, two writes in the same minute both present', async () => {
    const a = entryAt('addon', '2026-10-12T14:01:10Z', 1);
    const c = entryAt('companion', '2026-10-12T14:01:40Z', 2);
    const older = entryAt('companion', '2026-10-12T09:00:00Z', 3);
    const read = await readChangeLog(reader({
      'change_log.addon.2026-10': bucket('addon', '2026-10', [a]),
      'change_log.companion.2026-10': bucket('companion', '2026-10', [older, c]),
    }), NOW);
    expect(read.entries.map((e) => e.id)).toEqual([c.id, a.id, older.id]);
    expect(read.unreadable).toEqual([]);
  });

  it('reads this month and the three before it, plus every .2 fallback', async () => {
    const get = reader({});
    await readChangeLog(get, NOW);
    const keys = get.mock.calls.map(([k]) => k);
    expect(keys).toHaveLength(16);
    expect(keys).toContain('change_log.addon.2026-07');
    expect(keys).toContain('change_log.companion.2026-10.2');
    expect(keys).not.toContain('change_log.addon.2026-06');
  });

  it('drops anything older than 90 days', async () => {
    const old = entryAt('companion', '2026-07-13T12:00:00Z', 1);
    const kept = entryAt('companion', '2026-07-15T12:00:00Z', 2);
    const read = await readChangeLog(reader({ 'change_log.companion.2026-07': bucket('companion', '2026-07', [old, kept]) }), NOW);
    expect(read.entries.map((e) => e.id)).toEqual([kept.id]);
  });

  it('reports a corrupt bucket, reads its fallback, and says when both are unreadable', async () => {
    const saved = entryAt('companion', '2026-10-11T10:00:00Z', 1);
    const read = await readChangeLog(reader({
      'change_log.companion.2026-10': '{broken',
      'change_log.companion.2026-10.2': bucket('companion', '2026-10', [saved]),
      'change_log.addon.2026-09': 'x',
      'change_log.addon.2026-09.2': 'y',
    }), NOW);
    expect(read.entries.map((e) => e.id)).toEqual([saved.id]);
    expect(read.unreadable).toEqual([
      { writer: 'companion', month: '2026-10', paused: false },
      { writer: 'addon', month: '2026-09', paused: true },
    ]);
  });

  it('collects gaps with their writer, and adds up trims', async () => {
    const read = await readChangeLog(reader({
      'change_log.addon.2026-10': bucket('addon', '2026-10', [], { gaps: [{ at: '2026-10-11T08:00:00Z', count: 3, reason: "couldn't save the log" }], trimmed: 4 }),
      'change_log.companion.2026-09': bucket('companion', '2026-09', [], { trimmed: 2 }),
    }), NOW);
    expect(read.gaps).toEqual([{ at: '2026-10-11T08:00:00Z', count: 3, reason: "couldn't save the log", writer: 'addon' }]);
    expect(read.trimmed).toBe(6);
  });

  it('marks an entry undone when the newest entry reversing it is an undo (R2)', async () => {
    const filed = stampChange(categoryFiledChange({
      actor: 'auto', activityId: 'a', description: 'X', before: null, after: { categoryId: 'c', categoryName: 'Groceries' },
    }), 'companion', new Date('2026-10-10T10:00:00Z'));
    const undo = { ...entryAt('companion', '2026-10-11T10:00:00Z', 9), reverses: { id: filed.id, op: 'undo' as const } };
    const redone = { ...entryAt('addon', '2026-10-12T10:00:00Z', 10), reverses: { id: filed.id, op: 'redo' as const } };
    const once = await readChangeLog(reader({ 'change_log.companion.2026-10': bucket('companion', '2026-10', [filed, undo]) }), NOW);
    expect(once.entries.find((e) => e.id === filed.id)?.undone).toEqual({ by: undo.id, at: undo.at });
    const twice = await readChangeLog(reader({
      'change_log.companion.2026-10': bucket('companion', '2026-10', [filed, undo]),
      'change_log.addon.2026-10': bucket('addon', '2026-10', [redone]),
    }), NOW);
    expect(twice.entries.find((e) => e.id === filed.id)?.undone).toBeUndefined();
  });

  it('rejects when the host read fails', async () => {
    await expect(readChangeLog(async () => { throw new Error('ECONNREFUSED'); }, NOW)).rejects.toThrow('ECONNREFUSED');
  });
});
