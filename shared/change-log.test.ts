import { describe, it, expect, vi } from 'vitest';
import { bookkeepingChange, importChange, stampChange, type ChangeEntry, type ChangeWriter } from './change-entries.js';
import {
  appendChanges, CHANGE_LOG_CAP_BYTES, ChangeLogPausedError, changeLogKey, changeLogResetKeys, changeMonth,
  createChangeLogWriter, emptyChangeBucket, enforceChangeCap, GAP_REASON_UNREADABLE, GAP_REASON_WRITE,
  parseChangeBucket, shiftMonth, utf8Bytes, type ChangeBucket, type ChangeLogIo,
} from './change-log.js';
import { accountTxKey } from './transfers.js';
import { requireWealthfolioSecretKey } from './__fixtures__/wealthfolio-secret-key.js';

const NOW = new Date('2026-10-12T14:05:00Z');
const CHECKING = { sfinId: 'ACT-1f2e', wfId: 'wf-checking', name: 'Checking' };

/** A Map behind get/set, exactly as both hosts' secrets behave: strings. */
const memory = (entries: Record<string, string> = {}) => {
  const data = new Map(Object.entries(entries));
  const io: ChangeLogIo & { data: Map<string, string> } = {
    data,
    get: vi.fn(async (k: string) => { requireWealthfolioSecretKey(k); return data.get(k) ?? null; }),
    set: vi.fn(async (k: string, v: string) => { requireWealthfolioSecretKey(k); data.set(k, v); }),
    clear: vi.fn(async (k: string) => { requireWealthfolioSecretKey(k); data.set(k, ''); }),
  };
  return io;
};

const imported = (n: number, at = NOW, writer: ChangeWriter = 'companion'): ChangeEntry => stampChange(importChange({
  account: CHECKING, txKey: accountTxKey('ACT-1f2e', `TRN-${n}`), activityId: `act-${n}`, description: `KROGER #${n}`,
  amountCents: -100 * n, date: '2026-10-11', pending: false, activityType: 'WITHDRAWAL',
}), writer, at, 'cRUN');
const background = (n: number, at = NOW): ChangeEntry =>
  stampChange(bookkeepingChange({ step: 'external-marker', account: CHECKING, activityIds: [`bk-${n}`] }), 'companion', at, 'cRUN');
const stored = (io: { data: Map<string, string> }, key: string): ChangeBucket => JSON.parse(io.data.get(key)!);

describe('keys and months', () => {
  it('keys a bucket by writer and UTC month, with a .2 fallback', () => {
    expect(changeLogKey('companion', '2026-10')).toBe('change_log.companion.2026-10');
    expect(changeLogKey('addon', '2026-10', true)).toBe('change_log.addon.2026-10.2');
    expect(changeMonth('2026-10-31T23:30:00-05:00')).toBe('2026-11');
  });

  it('steps months across a year end', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-10', -4)).toBe('2026-06');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
  });

  it('names every key Reset clears: both writers, both keys, this month and four back', () => {
    const keys = changeLogResetKeys(NOW);
    expect(keys).toHaveLength(20);
    expect(keys).toContain('change_log.addon.2026-10');
    expect(keys).toContain('change_log.companion.2026-06.2');
    expect(keys).not.toContain('change_log.addon.2026-05');
  });

  it('only makes keys Wealthfolio accepts: a colon was refused with a 400, so nothing was ever saved', () => {
    for (const key of changeLogResetKeys(NOW)) expect(() => requireWealthfolioSecretKey(key), key).not.toThrow();
  });
});

describe('parseChangeBucket', () => {
  it('reads nothing and a cleared key as absent', () => {
    expect(parseChangeBucket(null, 'addon', '2026-10')).toEqual({ kind: 'absent' });
    expect(parseChangeBucket('', 'addon', '2026-10')).toEqual({ kind: 'absent' });
  });

  it('reads a well-formed bucket, tolerating a missing gaps list', () => {
    const raw = JSON.stringify({ v: 1, writer: 'addon', month: '2026-10', entries: [imported(1, NOW, 'addon')] });
    const parsed = parseChangeBucket(raw, 'addon', '2026-10');
    expect(parsed.kind).toBe('ok');
    expect(parsed.kind === 'ok' && parsed.bucket.gaps).toEqual([]);
  });

  it.each([
    ['not JSON', '{"v":1,'],
    ['another writer', JSON.stringify({ v: 1, writer: 'companion', month: '2026-10', entries: [], gaps: [] })],
    ['another month', JSON.stringify({ v: 1, writer: 'addon', month: '2026-09', entries: [], gaps: [] })],
    ['a newer version', JSON.stringify({ v: 2, writer: 'addon', month: '2026-10', entries: [], gaps: [] })],
    ['a broken entry', JSON.stringify({ v: 1, writer: 'addon', month: '2026-10', entries: [{ id: 'x' }], gaps: [] })],
    ['a broken gap', JSON.stringify({ v: 1, writer: 'addon', month: '2026-10', entries: [], gaps: [{ at: 1 }] })],
  ])('treats %s as corrupt', (_name, raw) => {
    expect(parseChangeBucket(raw, 'addon', '2026-10')).toEqual({ kind: 'corrupt' });
  });
});

describe('enforceChangeCap', () => {
  it('leaves a bucket under the cap alone', () => {
    const b = { ...emptyChangeBucket('companion', '2026-10'), entries: [imported(1)] };
    expect(enforceChangeCap(b)).toBe(b);
  });

  it('drops bookkeeping first, oldest first, then the oldest entries, and counts them', () => {
    const [bk1, imp1, bk2, imp2, imp3] = [background(1), imported(1), background(2), imported(2), imported(3)];
    const full = { ...emptyChangeBucket('companion', '2026-10'), entries: [bk1, imp1, bk2, imp2, imp3] };
    const sized = (entries: ChangeEntry[], trimmed: number) =>
      utf8Bytes(JSON.stringify({ ...emptyChangeBucket('companion', '2026-10'), entries, trimmed }));
    // Room for exactly the three imports: both bookkeeping rows go.
    const cut = enforceChangeCap(full, sized([imp1, imp2, imp3], 2));
    expect(cut.entries).toEqual([imp1, imp2, imp3]);
    expect(cut.trimmed).toBe(2);
    // Room for two: then the oldest import goes too.
    const tighter = enforceChangeCap(full, sized([imp2, imp3], 3));
    expect(tighter.entries).toEqual([imp2, imp3]);
    expect(tighter.trimmed).toBe(3);
    // A count already there is added to, never reset.
    expect(enforceChangeCap({ ...full, trimmed: 4 }, sized([imp1, imp2, imp3], 6)).trimmed).toBe(6);
  });

  it('measures UTF-8 bytes, not characters', () => {
    expect(utf8Bytes('café ↔️')).toBe(12);
  });
});

describe('appendChanges', () => {
  it('appends to this writer’s bucket for the entry’s month', async () => {
    const io = memory();
    await appendChanges(io.get, io.set, 'companion', [imported(1), imported(2)], NOW);
    const b = stored(io, 'change_log.companion.2026-10');
    expect(b).toMatchObject({ v: 1, writer: 'companion', month: '2026-10', gaps: [] });
    expect(b.entries.map((e) => e.subject.activityIds![0])).toEqual(['act-1', 'act-2']);
    await appendChanges(io.get, io.set, 'companion', [imported(3)], NOW);
    expect(stored(io, 'change_log.companion.2026-10').entries).toHaveLength(3);
  });

  it('puts a late entry from last month into last month’s bucket', async () => {
    const io = memory();
    await appendChanges(io.get, io.set, 'addon', [imported(1, new Date('2026-09-30T23:59:59Z'), 'addon'), imported(2, NOW, 'addon')], NOW);
    expect(stored(io, 'change_log.addon.2026-09').entries).toHaveLength(1);
    expect(stored(io, 'change_log.addon.2026-10').entries).toHaveLength(1);
  });

  it('never overwrites a corrupt bucket: it writes the .2 fallback instead', async () => {
    const io = memory({ 'change_log.companion.2026-10': '{"v":1,"writer":"companion"' });
    await appendChanges(io.get, io.set, 'companion', [imported(1)], NOW);
    expect(io.data.get('change_log.companion.2026-10')).toBe('{"v":1,"writer":"companion"');
    expect(stored(io, 'change_log.companion.2026-10.2').entries).toHaveLength(1);
  });

  it('pauses when the fallback is corrupt too, writing nothing', async () => {
    const io = memory({ 'change_log.companion.2026-10': 'x', 'change_log.companion.2026-10.2': 'y' });
    await expect(appendChanges(io.get, io.set, 'companion', [imported(1)], NOW)).rejects.toBeInstanceOf(ChangeLogPausedError);
    expect(io.set).not.toHaveBeenCalled();
  });

  it('keeps a bucket under the cap as it grows', async () => {
    const io = memory();
    const many = Array.from({ length: 700 }, (_, i) => imported(i));
    await appendChanges(io.get, io.set, 'companion', many, NOW);
    const raw = io.data.get('change_log.companion.2026-10')!;
    expect(utf8Bytes(raw)).toBeLessThanOrEqual(CHANGE_LOG_CAP_BYTES);
    const b = JSON.parse(raw) as ChangeBucket;
    expect(b.trimmed).toBeGreaterThan(0);
    expect(b.entries[b.entries.length - 1].subject.activityIds).toEqual(['act-699']);
  });
});

describe('createChangeLogWriter', () => {
  it('clears its own bucket from four months back on its first append of a month, once', async () => {
    const io = memory({ 'change_log.companion.2026-06': '{"old":true}' });
    const w = createChangeLogWriter({ writer: 'companion', now: () => NOW });
    await w.append(io, [imported(1)]);
    await w.append(io, [imported(2)]);
    expect(io.clear).toHaveBeenCalledTimes(18);
    expect(io.clear).toHaveBeenCalledWith('change_log.companion.2026-06');
    expect(io.clear).toHaveBeenCalledWith('change_log.companion.2026-06.2');
    expect(io.data.get('change_log.companion.2026-06')).toBe('');
  });

  it('also clears the months a writer skipped: -4 through -12, and nothing newer', async () => {
    const io = memory({
      'change_log.addon.2025-10': '{"old":true}', 'change_log.addon.2025-12.2': '{"old":true}',
      'change_log.addon.2026-07': '{"old":true}', 'change_log.addon.2026-06': '{"old":true}',
    });
    const w = createChangeLogWriter({ writer: 'addon', now: () => NOW });
    await w.append(io, [imported(1)]);
    for (const k of ['2025-10', '2026-06']) expect(io.data.get(`change_log.addon.${k}`)).toBe('');
    expect(io.data.get('change_log.addon.2025-12.2')).toBe('');
    expect(io.data.get('change_log.addon.2026-07')).toBe('{"old":true}');
    expect(io.clear).not.toHaveBeenCalledWith('change_log.addon.2025-09');
    expect(io.clear).not.toHaveBeenCalledWith('change_log.companion.2026-06');
  });

  it('never rejects, remembers a failed append, and writes it as a gap next time', async () => {
    const io = memory();
    let fail = true;
    io.set = vi.fn(async (k: string, v: string) => {
      if (fail) throw new Error('500 from Wealthfolio');
      io.data.set(k, v);
    });
    const w = createChangeLogWriter({ writer: 'companion', now: () => NOW });
    await expect(w.append(io, [imported(1), imported(2), imported(3)])).resolves.toBeUndefined();
    expect(w.pendingGaps()).toEqual([{ at: NOW.toISOString(), count: 3, reason: GAP_REASON_WRITE }]);
    fail = false;
    await w.append(io, [imported(4)]);
    const b = stored(io, 'change_log.companion.2026-10');
    expect(b.gaps).toEqual([{ at: NOW.toISOString(), count: 3, reason: GAP_REASON_WRITE }]);
    expect(b.entries).toHaveLength(1);
    expect(w.pendingGaps()).toEqual([]);
  });

  it('appendStrict resolves { saved } for THIS append and still leaves the gap record on a failure (PB-I)', async () => {
    const io = memory();
    let fail = true;
    io.set = vi.fn(async (k: string, v: string) => {
      if (fail) throw new Error('500 from Wealthfolio');
      io.data.set(k, v);
    });
    const w = createChangeLogWriter({ writer: 'companion', now: () => NOW });
    await expect(w.appendStrict(io, [imported(1)])).resolves.toEqual({ saved: false });
    expect(w.pendingGaps()).toEqual([{ at: NOW.toISOString(), count: 1, reason: GAP_REASON_WRITE }]);
    fail = false;
    await expect(w.appendStrict(io, [imported(2)])).resolves.toEqual({ saved: true });
    expect(stored(io, 'change_log.companion.2026-10').entries).toHaveLength(1);
    // Nothing to write is nothing lost.
    await expect(w.appendStrict(io, [])).resolves.toEqual({ saved: true });
  });

  it('counts a paused month as an unreadable gap', async () => {
    const io = memory({ 'change_log.addon.2026-10': 'x', 'change_log.addon.2026-10.2': 'y' });
    const w = createChangeLogWriter({ writer: 'addon', now: () => NOW });
    await w.append(io, [imported(1, NOW, 'addon')]);
    expect(w.pendingGaps()).toEqual([{ at: NOW.toISOString(), count: 1, reason: GAP_REASON_UNREADABLE }]);
  });

  it('runs appends one after another, so near-simultaneous ones both land', async () => {
    const io = memory();
    const realGet = io.get;
    // A slow first read would let a second, unqueued append read the same empty bucket.
    io.get = vi.fn(async (k: string) => { await new Promise((r) => setTimeout(r, 5)); return realGet(k); });
    const w = createChangeLogWriter({ writer: 'companion', now: () => NOW });
    await Promise.all([w.append(io, [imported(1)]), w.append(io, [imported(2)])]);
    expect(stored(io, 'change_log.companion.2026-10').entries.map((e) => e.subject.activityIds![0])).toEqual(['act-1', 'act-2']);
  });

  it('two writers in the same minute write two keys and lose nothing', async () => {
    const io = memory();
    const addon = createChangeLogWriter({ writer: 'addon', now: () => NOW });
    const companion = createChangeLogWriter({ writer: 'companion', now: () => NOW });
    await Promise.all([addon.append(io, [imported(1, NOW, 'addon')]), companion.append(io, [imported(2)])]);
    expect(stored(io, 'change_log.addon.2026-10').entries).toHaveLength(1);
    expect(stored(io, 'change_log.companion.2026-10').entries).toHaveLength(1);
  });
});
