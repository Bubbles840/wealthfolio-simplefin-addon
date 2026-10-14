import { describe, it, expect, vi } from 'vitest';
import { runDateRepair, type DateRepairDeps } from './date-repair.js';
import { DATE_REPAIR_SECRET_KEY, DATE_REPAIR_PAUSE_MS, type DateRepairRow } from '../../shared/date-repair.js';
import type { ActivityWrite } from '../../shared/sync-host.js';
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
    overriddenIds: vi.fn(() => new Set<string>()),
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
    expect(result).toEqual({ ran: true, moved: 2, failed: 0, skippedGrouped: 1, skippedOverride: 0 });
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
    expect(f.deps.searchPage).toHaveBeenCalledTimes(2); // one page per mapped account, first run only
  });

  it('after a partial failure, says so, leaves the marker unwritten, and the next sync moves only what is left', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`r${i}`));
    let refuse = true;
    const f = fake(rows);
    const save = f.deps.saveUpdates;
    f.deps.saveUpdates = vi.fn(async (w: ActivityWrite[]) => (refuse && w.some((u) => u.id === 'r27') ? { errors: [{ action: 'update', message: 'locked' }] } : save(w)));
    const first = await runDateRepair(f.deps, NOW);
    expect(first).toMatchObject({ ran: true, moved: 29, failed: 1 });
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
});
