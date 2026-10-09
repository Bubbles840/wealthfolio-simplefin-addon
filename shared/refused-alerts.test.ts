import { describe, it, expect } from 'vitest';
import { parseAnnouncedRefusals, refusalKey, unannouncedRefusals, withAnnouncedRefusals } from './refused-alerts.js';

const NOW = new Date('2026-10-09T12:00:00Z');
const row = (txId: string, amountCents = 130000, date = '2026-10-01') => ({ txId, amountCents, date, description: 'X', currency: 'USD', accountName: 'Spend' });

describe('refused-import announcements', () => {
  it('announces a refusal once, not on every sync that is refused again', () => {
    // A refused row is never stored, so the next sync is refused the same way.
    const first = unannouncedRefusals([row('a')], {});
    expect(first).toHaveLength(1);
    const announced = withAnnouncedRefusals({}, first, NOW);
    expect(unannouncedRefusals([row('a')], announced)).toEqual([]);
  });

  it('announces a different charge under a reused id afresh', () => {
    const announced = withAnnouncedRefusals({}, [row('a')], NOW);
    expect(unannouncedRefusals([row('a', 999)], announced)).toHaveLength(1);
  });

  it('forgets announcements older than any feed window', () => {
    const old = { [refusalKey(row('a'))]: '2026-01-01T00:00:00.000Z' };
    expect(withAnnouncedRefusals(old, [row('b')], NOW)).toEqual({ [refusalKey(row('b'))]: NOW.toISOString() });
  });

  it('reads a corrupt record as empty — announcing again is the safe direction', () => {
    expect(parseAnnouncedRefusals('not json')).toEqual({});
    expect(parseAnnouncedRefusals('[1]')).toEqual({});
    expect(parseAnnouncedRefusals(null)).toEqual({});
  });
});
