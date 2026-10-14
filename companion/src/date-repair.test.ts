import { describe, it, expect, vi } from 'vitest';
import { runDateRepair, type DateRepairDeps } from './date-repair.js';
import { DATE_REPAIR_SECRET_KEY, DATE_REPAIR_PAUSE_MS, type DateRepairRow } from '../../shared/date-repair.js';
import type { DateRepairWrite as ActivityWrite } from '../../shared/date-repair.js';
import type { ChangeDraft } from '../../shared/change-entries.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const row = (id: string, over: Partial<DateRepairRow> = {}): DateRepairRow => ({
  id, accountId: 'wf-chk', date: '2026-10-01T00:00:00+00:00', activityType: 'WITHDRAWAL', currency: 'USD',
  comment: `${id.toUpperCase()} · TRN-${id}`, sourceGroupId: null, ...over,
});

/** Wealthfolio as the repair sees it: its rows by account, its secrets, its writes. */
function fake(rows: DateRepairRow[], over: Partial<DateRepairDeps> = {}) {
  const secrets = new Map<string, string>();
  const writes: ActivityWrite[][] = [];
  const recorded: ChangeDraft[] = [];
  const deps: DateRepairDeps = {
    getSecret: vi.fn(async (k: string) => secrets.get(k) ?? null),
    setSecret: vi.fn(async (k: string, v: string) => { secrets.set(k, v); }),
    mappedAccountIds: vi.fn(async () => ['wf-chk', 'wf-visa']),
    searchPage: vi.fn(async (accountId: string, page: number, pageSize: number) =>
      rows.filter((r) => r.accountId === accountId).slice(page * pageSize, (page + 1) * pageSize)),
    installedAddonVersion: vi.fn(() => null),
    searchByIds: vi.fn(async (ids: string[]) => rows.filter((r) => ids.includes(r.id)).map((r) => ({ ...r }))),
    overriddenIds: vi.fn(() => new Set<string>()),
    storedTypes: vi.fn(() => new Map(rows.map((r) => [r.id, r.activityType]))),
    saveUpdates: vi.fn(async (w: ActivityWrite[]) => {
      writes.push(w);
      for (const u of w) {
        const r = rows.find((x) => x.id === u.id);
        if (r) r.date = u.activityDate.replace('Z', '+00:00');
      }
      return { errors: [] };
    }),
    record: vi.fn(async (d: ChangeDraft) => { recorded.push(d); }),
    sleep: vi.fn(async () => {}),
    log: vi.fn(),
    ...over,
  };
  return { deps, secrets, writes, recorded };
}

describe('runDateRepair', () => {
  it('moves every mapped row at 00:00 UTC, skips linked legs, logs one entry and marks itself done', async () => {
    const rows = [row('a'), row('b', { accountId: 'wf-visa' }), row('g', { sourceGroupId: 'g-1' }), row('n', { date: '2026-10-02T12:00:00+00:00' })];
    const f = fake(rows);
    const result = await runDateRepair(f.deps, NOW);
    expect(result).toEqual({ ran: true, moved: 2, failed: 0, transient: 0, changed: 0, skippedGrouped: 1, skippedOverride: 0 });
    expect(f.writes.flat().map((w) => [w.id, w.activityDate])).toEqual([['a', '2026-10-01T12:00:00Z'], ['b', '2026-10-01T12:00:00Z']]);
    expect(f.recorded).toEqual([expect.objectContaining({ kind: 'bookkeeping', after: { step: 'date-repair', count: 2, skipped: 1 } })]);
    expect(JSON.parse(f.secrets.get(DATE_REPAIR_SECRET_KEY)!)).toEqual({ at: NOW.toISOString(), moved: 2, skippedGrouped: 1, skippedOverride: 0 });
    // The grouped leg and the noon row are as they were.
    expect(rows.find((r) => r.id === 'g')!.date).toBe('2026-10-01T00:00:00+00:00');
    expect(rows.find((r) => r.id === 'n')!.date).toBe('2026-10-02T12:00:00+00:00');
  });

  it('runs once: a second sync reads the marker and touches nothing', async () => {
    const f = fake([row('a')]);
    await runDateRepair(f.deps, NOW);
    const writesAfterFirst = f.writes.length;
    const again = await runDateRepair(f.deps, new Date('2026-10-15T15:00:00Z'));
    expect(again.ran).toBe(false);
    expect(f.writes).toHaveLength(writesAfterFirst);
    expect(f.deps.searchPage).toHaveBeenCalledTimes(4); // a sweep and a verifying sweep: one page per mapped account, first run only
  });

  it('after a partial failure, says so, leaves the marker unwritten, and the next sync moves only what is left', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`r${i}`));
    let refuse = true;
    const f = fake(rows);
    const save = f.deps.saveUpdates;
    f.deps.saveUpdates = vi.fn(async (w: ActivityWrite[]) => (refuse && w.some((u) => u.id === 'r27') ? Promise.reject(new Error('saveMany failed: 503')) : save(w)));
    const first = await runDateRepair(f.deps, NOW);
    expect(first).toMatchObject({ ran: true, moved: 29, failed: 1, transient: 1 });
    expect(f.secrets.has(DATE_REPAIR_SECRET_KEY)).toBe(false);
    expect(f.deps.log).toHaveBeenCalledWith('Date repair: moved 29 row(s); 1 could not be moved — the next sync tries again.');
    // Paced: a pause between the two batches.
    expect(f.deps.sleep).toHaveBeenCalledWith(DATE_REPAIR_PAUSE_MS);
    refuse = false;
    const second = await runDateRepair(f.deps, NOW);
    expect(second).toMatchObject({ ran: true, moved: 1, failed: 0 });
    expect(f.writes.at(-1)!.map((w) => w.id)).toEqual(['r27']);
    expect(f.secrets.has(DATE_REPAIR_SECRET_KEY)).toBe(true);
  });

  it('does not run without the database (a row’s type override is unknown) or without Wealthfolio', async () => {
    const noDb = fake([row('a')], { overriddenIds: vi.fn(() => { throw new Error('no database'); }) });
    expect((await runDateRepair(noDb.deps, NOW)).ran).toBe(false);
    expect(noDb.writes).toEqual([]);
    const down = fake([row('a')], { getSecret: vi.fn(async () => { throw new Error('unreachable'); }) });
    expect((await runDateRepair(down.deps, NOW)).ran).toBe(false);
    expect(down.writes).toEqual([]);
  });

  it('leaves a row with a type override alone', async () => {
    const f = fake([row('a'), row('o')], { overriddenIds: vi.fn(() => new Set(['o'])) });
    expect(await runDateRepair(f.deps, NOW)).toMatchObject({ moved: 1, skippedOverride: 1 });
    expect(f.writes.flat().map((w) => w.id)).toEqual(['a']);
  });

  // ── Fix round 1 (LU-F) ──

  it('I1: a note edited between the sweep and the write is NOT overwritten', async () => {
    const rows = [row('a'), row('b')];
    const f = fake(rows);
    const real = f.deps.searchPage;
    f.deps.searchPage = vi.fn(async (...args: Parameters<typeof real>) => {
      const out = (await real(...args)).map((r) => ({ ...r }));
      rows.find((r) => r.id === 'a')!.comment = 'EDITED BY HAND'; // after the sweep reads it
      return out;
    });
    const result = await runDateRepair(f.deps, NOW);
    expect(f.writes.flat().map((w) => w.id)).toEqual(['b']);
    expect(rows.find((r) => r.id === 'a')!.comment).toBe('EDITED BY HAND');
    expect(result.changed).toBe(1);
  });

  it('I1: a row linked between the sweep and the write is NOT written, and one that vanished is dropped', async () => {
    const rows = [row('a'), row('b'), row('c')];
    const f = fake(rows);
    const real = f.deps.searchPage;
    f.deps.searchPage = vi.fn(async (...args: Parameters<typeof real>) => {
      const out = (await real(...args)).map((r) => ({ ...r }));
      if (rows.some((r) => r.id === 'c')) {
        rows.find((r) => r.id === 'a')!.sourceGroupId = 'g-9';
        rows.splice(rows.findIndex((r) => r.id === 'c'), 1);
      }
      return out;
    });
    const result = await runDateRepair(f.deps, NOW);
    expect(f.writes.flat().map((w) => w.id)).toEqual(['b']);
    expect(result).toMatchObject({ moved: 1, changed: 2 });
  });

  it('I2: waits for the 1.62 add-on — no sweep, no marker — and runs on 1.62.0, later, or an unknown version', async () => {
    for (const v of ['1.61.0', '1.0.0']) {
      const old = fake([row('a')], { installedAddonVersion: vi.fn(() => v) });
      expect((await runDateRepair(old.deps, NOW)).ran).toBe(false);
      expect(old.deps.log).toHaveBeenCalledWith('Date repair waits for the 1.62 add-on.');
      expect(old.deps.searchPage).not.toHaveBeenCalled();
      expect(old.secrets.size).toBe(0);
    }
    for (const v of ['1.62.0', '1.62.1', '2.0.0', null]) {
      const ok = fake([row('a')], { installedAddonVersion: vi.fn(() => v) });
      expect((await runDateRepair(ok.deps, NOW)).moved).toBe(1);
    }
  });

  it('m1/m4: a row whose stored type differs from the search’s, or a blank type, is left alone', async () => {
    const rows = [row('a'), row('stale', { activityType: 'DEPOSIT' }), row('blank', { activityType: '' })];
    const f = fake(rows, { storedTypes: vi.fn(() => new Map([['a', 'WITHDRAWAL'], ['stale', 'WITHDRAWAL'], ['blank', 'WITHDRAWAL']])) });
    expect(await runDateRepair(f.deps, NOW)).toMatchObject({ moved: 1, skippedOverride: 2 });
    expect(f.writes.flat().map((w) => w.id)).toEqual(['a']);
  });

  it('m1: a row the database does not know is left alone', async () => {
    const f = fake([row('a')], { storedTypes: vi.fn(() => new Map()) });
    expect(await runDateRepair(f.deps, NOW)).toMatchObject({ moved: 0, skippedOverride: 1 });
  });

  it('m3: a row with no sourceGroupId field is treated as linked', async () => {
    const f = fake([row('a', { sourceGroupId: undefined }), row('b')]);
    expect(await runDateRepair(f.deps, NOW)).toMatchObject({ moved: 1, skippedGrouped: 1 });
  });

  it('m10: an always-refused row is reported as failed, never retried forever, and the marker is still written', async () => {
    const rows = [row('a'), row('bad')];
    const f = fake(rows);
    const save = f.deps.saveUpdates;
    f.deps.saveUpdates = vi.fn(async (w: ActivityWrite[]) => (w.some((u) => u.id === 'bad') ? { errors: [{ action: 'update', message: 'Activity type cannot be empty' }] } : save(w)));
    const first = await runDateRepair(f.deps, NOW);
    expect(first).toMatchObject({ ran: true, moved: 1, failed: 1, transient: 0 });
    expect(f.recorded[0]).toMatchObject({ after: { step: 'date-repair', count: 1, failed: 1 } });
    expect(f.secrets.has(DATE_REPAIR_SECRET_KEY)).toBe(true);
    expect((await runDateRepair(f.deps, NOW)).ran).toBe(false);
  });

  it('a 4xx thrown for one row is permanent; a 5xx is not', async () => {
    const f = fake([row('a'), row('bad')]);
    const save = f.deps.saveUpdates;
    f.deps.saveUpdates = vi.fn(async (w: ActivityWrite[]) => (w.some((u) => u.id === 'bad') ? Promise.reject(new Error('saveMany failed: 422 - nope')) : save(w)));
    expect(await runDateRepair(f.deps, NOW)).toMatchObject({ failed: 1, transient: 0 });
    expect(f.secrets.has(DATE_REPAIR_SECRET_KEY)).toBe(true);
  });

  it('m10: pages past 500 rows', async () => {
    const rows = Array.from({ length: 1230 }, (_, i) => row(`p${i}`));
    const f = fake(rows);
    expect(await runDateRepair(f.deps, NOW)).toMatchObject({ moved: 1230, failed: 0 });
    expect(f.deps.searchPage).toHaveBeenCalledWith('wf-chk', 2, 500);
    expect(f.secrets.has(DATE_REPAIR_SECRET_KEY)).toBe(true);
  });

  it('m2: reaching the page limit is not done: logged, no marker', async () => {
    const f = fake(Array.from({ length: 5 }, (_, i) => row(`p${i}`)));
    const result = await runDateRepair(f.deps, NOW, { pageSize: 2, maxPages: 2 });
    expect(result.moved).toBe(4);
    expect(f.secrets.has(DATE_REPAIR_SECRET_KEY)).toBe(false);
    expect(f.deps.log).toHaveBeenCalledWith(expect.stringContaining('not all were read'));
  });

  it('m2: a row seen twice (a page shifted) is moved once', async () => {
    const rows = [row('a')];
    const f = fake(rows, { searchPage: vi.fn(async (acc: string, page: number) => (page === 0 && acc === 'wf-chk' ? [rows[0], { ...rows[0] }] : [])) });
    await runDateRepair(f.deps, NOW, { pageSize: 2 });
    expect(f.writes.flat().map((w) => w.id)).toEqual(['a']);
  });

  it('m2: a row still at midnight in the verifying sweep keeps the marker back', async () => {
    const rows = [row('a')];
    const f = fake(rows);
    const save = f.deps.saveUpdates;
    f.deps.saveUpdates = vi.fn(async (w: ActivityWrite[]) => { await save(w); rows[0].date = '2026-10-01T00:00:00+00:00'; return { errors: [] }; }); // another writer moves it back
    await runDateRepair(f.deps, NOW);
    expect(f.secrets.has(DATE_REPAIR_SECRET_KEY)).toBe(false);
  });

  it('m7: the entry lists at most 200 ids and carries the full count', async () => {
    const f = fake(Array.from({ length: 230 }, (_, i) => row(`p${i}`)));
    await runDateRepair(f.deps, NOW);
    expect(f.recorded[0].subject.activityIds).toHaveLength(200);
    expect(f.recorded[0].after).toMatchObject({ count: 230 });
    expect(f.recorded[0].summary).toContain('Moved 230 rows');
  });

  it('m8: a marker write that fails after the moves says so', async () => {
    const f = fake([row('a')], { setSecret: vi.fn(async () => { throw new Error('down'); }) });
    expect(await runDateRepair(f.deps, NOW)).toMatchObject({ ran: true, moved: 1 });
    expect(f.deps.log).toHaveBeenCalledWith("Date repair moved 1 rows but couldn't record it — it will check again next sync.");
  });

  it('m10: a change-log failure does not block the marker', async () => {
    const f = fake([row('a')], { record: vi.fn(async () => { throw new Error('log down'); }) });
    await runDateRepair(f.deps, NOW);
    expect(f.secrets.has(DATE_REPAIR_SECRET_KEY)).toBe(true);
    expect(f.deps.log).toHaveBeenCalledWith(expect.stringContaining('Change log skipped'));
  });
});
