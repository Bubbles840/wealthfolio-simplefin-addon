import { describe, it, expect } from 'vitest';
import {
  pruneDismissals, visibleUncategorized, DISMISSAL_MAX_AGE_DAYS, UNCATEGORIZED_ROWS_CAP,
  type DismissalLedger, type UncategorizedRow,
} from './uncategorized.js';

const row = (over: Partial<UncategorizedRow> = {}): UncategorizedRow => ({
  activityId: 'act-1',
  date: '2026-08-01',
  amountCents: 7000,
  description: 'Thankyou Points Redeemed',
  accountName: 'Citi Double Cash',
  ...over,
});

describe('visibleUncategorized', () => {
  it('hides rows the user dismissed and keeps the rest', () => {
    // THE definition of "still needs a category". Both hosts call this — the
    // companion to size its count, the addon to render its list — so a second
    // copy of this rule is how the tile and the list start disagreeing.
    const rows = [row({ activityId: 'a' }), row({ activityId: 'b' }), row({ activityId: 'c' })];
    const ledger: DismissalLedger = { b: '2026-08-01T00:00:00.000Z' };
    expect(visibleUncategorized(rows, ledger).map((r) => r.activityId)).toEqual(['a', 'c']);
  });

  it('ignores ledger entries for rows that are not present', () => {
    // A dismissal outlives its row by design (60 days vs a 90-day window), so
    // stale entries are normal, not a bug to guard against.
    const rows = [row({ activityId: 'a' })];
    expect(visibleUncategorized(rows, { zzz: '2026-01-01T00:00:00.000Z' })).toHaveLength(1);
  });

  it('is a no-op for an empty ledger', () => {
    const rows = [row({ activityId: 'a' }), row({ activityId: 'b' })];
    expect(visibleUncategorized(rows, {})).toHaveLength(2);
  });

  it('does not mutate its inputs', () => {
    // The addon calls this on every render against state it also holds.
    const rows = [row({ activityId: 'a' }), row({ activityId: 'b' })];
    const ledger: DismissalLedger = { a: '2026-08-01T00:00:00.000Z' };
    visibleUncategorized(rows, ledger);
    expect(rows).toHaveLength(2);
    expect(Object.keys(ledger)).toEqual(['a']);
  });
});

describe('pruneDismissals', () => {
  it('drops entries past the retention window and keeps fresh ones', () => {
    const now = new Date('2026-08-09T12:00:00.000Z');
    const old = new Date(now.getTime() - (DISMISSAL_MAX_AGE_DAYS + 1) * 86400_000).toISOString();
    const fresh = new Date(now.getTime() - 5 * 86400_000).toISOString();
    expect(pruneDismissals({ stale: old, keep: fresh }, now)).toEqual({ keep: fresh });
  });

  it('drops an unparseable timestamp rather than keeping it forever', () => {
    const now = new Date('2026-08-09T12:00:00.000Z');
    expect(pruneDismissals({ bad: 'not a date' }, now)).toEqual({});
  });
});

describe('UNCATEGORIZED_ROWS_CAP', () => {
  it('is 50 — the published list is capped while the count stays true', () => {
    expect(UNCATEGORIZED_ROWS_CAP).toBe(50);
  });
});
