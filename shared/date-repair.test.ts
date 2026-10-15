import { describe, it, expect } from 'vitest';
import {
  batches, dateRepairWrite, parseDateRepairMarker, planDateRepair, utcMidnightDay, DATE_REPAIR_BATCH, DATE_REPAIR_SECRET_KEY,
  type DateRepairRow,
} from './date-repair.js';
import { bookkeepingChange } from './change-entries.js';

const row = (over: Partial<DateRepairRow> = {}): DateRepairRow => ({
  id: 'a1', accountId: 'wf-chk', date: '2026-10-01T00:00:00+00:00', activityType: 'WITHDRAWAL', currency: 'USD',
  comment: 'RENT PORTAL · TRN-1', sourceGroupId: null, ...over,
});
const opts = { mappedAccountIds: new Set(['wf-chk', 'wf-visa']), overriddenIds: new Set<string>() };

describe('utcMidnightDay — exactly 00:00:00 UTC, in each form Wealthfolio returns', () => {
  it.each([
    ['2026-10-01', '2026-10-01'], ['2026-10-01T00:00:00Z', '2026-10-01'], ['2026-10-01T00:00:00+00:00', '2026-10-01'],
    ['2026-10-01T00:00:00.000Z', '2026-10-01'], [' 2026-10-01T00:00:00+00:00 ', '2026-10-01'],
    ['2026-10-01 00:00:00', '2026-10-01'], ['2026-10-01T00:00:00', '2026-10-01'],
  ])('%s → %s', (stored, day) => expect(utcMidnightDay(stored)).toBe(day));

  it.each([
    '2026-10-01T12:00:00Z', '2026-10-01T04:00:00+00:00', '2026-10-01T00:00:01Z', '2026-10-01T00:00:00-04:00', '2026-10-01T00:00:00.5Z', 'soon', '',
  ])('%s is not', (stored) => expect(utcMidnightDay(stored)).toBeNull());
});

describe('planDateRepair', () => {
  it('M-1: with Wealthfolio’s timezone, moves a row only when noon UTC on its day is that same day there (UTC+12..+14 rows are already right)', () => {
    const zone = (timeZone: string | null) => planDateRepair([row({ date: '2026-10-31T00:00:00+00:00' })], { ...opts, timeZone }).moves.length;
    expect(zone('America/New_York')).toBe(1);
    expect(zone('Europe/Berlin')).toBe(1);
    expect(zone('Pacific/Auckland')).toBe(0); // NZDT UTC+13: 00:00Z is already Oct 31 13:00 local; noon would be Nov 1
    expect(zone('Pacific/Kiritimati')).toBe(0); // UTC+14
    expect(zone('Pacific/Fiji')).toBe(0); // UTC+12 (+13 in summer)
    expect(zone('Pacific/Noumea')).toBe(1); // UTC+11: noon is still the same day
    // No timezone given: the plan does not look at the zone at all (the caller's choice).
    expect(planDateRepair([row({ date: '2026-10-31T00:00:00+00:00' })], opts).moves).toHaveLength(1);
  });

  it('moves a mapped, ungrouped row at 00:00 UTC to noon on its date, date only, with its own note', () => {
    expect(planDateRepair([row()], opts)).toEqual({
      moves: [{ row: row(), write: { id: 'a1', accountId: 'wf-chk', activityType: 'WITHDRAWAL', activityDate: '2026-10-01T12:00:00Z', currency: 'USD', comment: 'RENT PORTAL · TRN-1' } }],
      skippedGrouped: 0, skippedOverride: 0, unknown: 0,
    });
    // Nothing else is sent: Wealthfolio's update keeps the asset, amount, subtype, metadata and filings it is not sent.
    expect(Object.keys(dateRepairWrite(row(), '2026-10-01')).sort()).toEqual(['accountId', 'activityDate', 'activityType', 'comment', 'currency', 'id']);
    expect(dateRepairWrite(row({ comment: null }), '2026-10-01').comment).toBeNull();
  });

  it('skips a row in a group — a linked transfer keeps its date, and its partner’s', () => {
    const plan = planDateRepair([row({ sourceGroupId: 'g-1' }), row({ id: 'a2', sourceGroupId: '' })], opts);
    expect(plan.moves.map((m) => m.row.id)).toEqual(['a2']);
    expect(plan.skippedGrouped).toBe(1);
  });

  it('skips a row with no sourceGroupId field at all: unknown counts as linked', () => {
    const plan = planDateRepair([row({ sourceGroupId: undefined })], opts);
    expect(plan).toMatchObject({ moves: [], skippedGrouped: 1 });
  });

  it('skips a row whose stored type is not the type the search shows', () => {
    const storedTypes = new Map([['a1', 'DEPOSIT']]);
    expect(planDateRepair([row()], { ...opts, storedTypes })).toMatchObject({ moves: [], skippedOverride: 1 });
    expect(planDateRepair([row()], { ...opts, storedTypes: new Map() })).toMatchObject({ moves: [], skippedOverride: 0, unknown: 1 }); // I1: unknown, never "retyped"
    expect(planDateRepair([row()], { ...opts, storedTypes: new Map([['a1', 'WITHDRAWAL']]) }).moves).toHaveLength(1);
  });

  it('skips a row whose type Wealthfolio overrides: the search shows only the effective type', () => {
    const plan = planDateRepair([row()], { ...opts, overriddenIds: new Set(['a1']) });
    expect(plan).toMatchObject({ moves: [], skippedOverride: 1 });
  });

  it('never touches a row at any other instant, or in an account the add-on does not map', () => {
    const plan = planDateRepair([
      row({ id: 'noon', date: '2026-10-01T12:00:00+00:00' }),
      row({ id: 'local', date: '2026-10-01T04:00:00+00:00' }),
      row({ id: 'second', date: '2026-10-01T00:00:01+00:00' }),
      row({ id: 'elsewhere', accountId: 'wf-brokerage' }),
      row({ id: 'bare', date: '2026-10-02' }),
    ], opts);
    expect(plan.moves.map((m) => [m.row.id, m.write.activityDate])).toEqual([['bare', '2026-10-02T12:00:00Z']]);
    expect(plan.skippedGrouped + plan.skippedOverride).toBe(0);
  });

  it('writes in batches', () => {
    expect(DATE_REPAIR_BATCH).toBe(25);
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batches(Array.from({ length: 60 }, (_, i) => i)).map((b) => b.length)).toEqual([25, 25, 10]);
    expect(batches([])).toEqual([]);
  });
});

describe('the done marker and the change log', () => {
  it('reads a marker it wrote, and anything else as not done', () => {
    expect(DATE_REPAIR_SECRET_KEY).toBe('date_repair_done');
    expect(parseDateRepairMarker(JSON.stringify({ at: '2026-10-14T12:00:00.000Z', moved: 12, skippedGrouped: 3, skippedOverride: 0 })))
      .toEqual({ at: '2026-10-14T12:00:00.000Z', moved: 12, skippedGrouped: 3, skippedOverride: 0 });
    for (const raw of [null, undefined, '', '{oops', '[]', '"done"', JSON.stringify({ moved: 1 })]) expect(parseDateRepairMarker(raw)).toBeNull();
  });

  it('records one background bookkeeping entry carrying the counts', () => {
    const d = bookkeepingChange({ step: 'date-repair', activityIds: ['a1', 'a2'], skipped: 3 });
    expect(d).toMatchObject({
      actor: 'auto', kind: 'bookkeeping', undoable: false, subject: { activityIds: ['a1', 'a2'] },
      after: { step: 'date-repair', count: 2, skipped: 3 },
      summary: "Moved 2 rows stored at midnight UTC to noon on the same date, so Wealthfolio counts them on the bank's day — 3 linked or retyped rows left as they were",
    });
    const capped = bookkeepingChange({ step: 'date-repair', activityIds: ['a1'], total: 230, skipped: 0, failed: 2 });
    expect(capped.summary).toContain('Moved 230 rows');
    expect(capped.summary).toContain('2 refused by Wealthfolio');
    expect(capped).toMatchObject({ after: { count: 230, failed: 2 } });
    expect(bookkeepingChange({ step: 'date-repair', activityIds: ['a1'], skipped: 0 }).summary)
      .toBe("Moved 1 row stored at midnight UTC to noon on the same date, so Wealthfolio counts it on the bank's day");
  });
});
