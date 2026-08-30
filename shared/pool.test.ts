import { describe, it, expect } from 'vitest';
import {
  computePoolStatus,
  computeRunwayMonths,
  parsePoolConfig,
  POOL_ENDED_GRACE_DAYS,
  type SemesterPoolConfig,
} from './pool.js';

/** The live case this feature was designed around: $16,000 landing Aug 25,
 *  must last until Dec 12. */
const cfg: SemesterPoolConfig = {
  amountCents: 1_600_000,
  startDate: '2026-08-25',
  endDate: '2026-12-12',
};

describe('computePoolStatus', () => {
  it('reports remaining, paces, and a run-out date past the end when under pace', () => {
    // Oct 1: day 38 of the pool (start day inclusive), 72 days to go.
    const s = computePoolStatus(cfg, 450_000, new Date('2026-10-01T12:00:00Z'));
    expect(s.phase).toBe('active');
    // The status carries its own dates so `pool_status` consumers never need a
    // second read of the config.
    expect(s.startDate).toBe('2026-08-25');
    expect(s.endDate).toBe('2026-12-12');
    expect(s.remainingCents).toBe(1_150_000);
    expect(s.spentCents).toBe(450_000);
    expect(s.daysElapsed).toBe(38);
    expect(s.daysLeft).toBe(72);
    // remaining ÷ daysLeft × 7 = 1,150,000/72*7 = 111,805.55… → rounded
    expect(s.sustainableWeeklyCents).toBe(111_806);
    // spent ÷ daysElapsed × 7 = 450,000/38*7 = 82,894.7… → rounded
    expect(s.actualWeeklyCents).toBe(82_895);
    // Daily burn 11,842.1…; remaining lasts 97 whole days → Jan 6, after Dec 12.
    expect(s.projectedRunOutDate).toBe('2027-01-06');
    expect(s.runsOutBeforeEnd).toBe(false);
  });

  it('projects a run-out before the end when over pace', () => {
    // Oct 1, but $9,000 already gone: burn 23,684/day leaves 29 whole days in
    // the money → Oct 30, six weeks before Dec 12.
    const s = computePoolStatus(cfg, 900_000, new Date('2026-10-01T12:00:00Z'));
    expect(s.projectedRunOutDate).toBe('2026-10-30');
    expect(s.runsOutBeforeEnd).toBe(true);
  });

  it('has no run-out projection before any spending happens', () => {
    const s = computePoolStatus(cfg, 0, new Date('2026-08-25T12:00:00Z'));
    expect(s.phase).toBe('active');
    expect(s.projectedRunOutDate).toBeNull();
    expect(s.runsOutBeforeEnd).toBe(false);
  });

  it('never divides by zero on the last day of the pool', () => {
    const s = computePoolStatus(cfg, 1_550_000, new Date('2026-12-12T12:00:00Z'));
    expect(s.phase).toBe('active');
    expect(s.daysLeft).toBe(0);
    // Whatever remains on the final day is the week's allowance — not NaN.
    expect(s.sustainableWeeklyCents).toBe(50_000);
  });

  it('is upcoming before the start date and ended after the grace window', () => {
    expect(computePoolStatus(cfg, 0, new Date('2026-08-20T12:00:00Z')).phase).toBe('upcoming');
    const gone = new Date('2026-12-12T12:00:00Z');
    gone.setUTCDate(gone.getUTCDate() + POOL_ENDED_GRACE_DAYS + 1);
    expect(computePoolStatus(cfg, 1_600_000, gone).phase).toBe('gone');
  });

  it('is ended (still reportable) within the grace window after the end date', () => {
    const s = computePoolStatus(cfg, 1_700_000, new Date('2026-12-15T12:00:00Z'));
    expect(s.phase).toBe('ended');
    // Overspent pools report a negative remainder rather than clamping: the
    // wrap-up line says "$1,000 over", and that sign is where it comes from.
    expect(s.remainingCents).toBe(-100_000);
  });

  it('can overspend mid-pool without producing negative paces', () => {
    const s = computePoolStatus(cfg, 1_700_000, new Date('2026-10-01T12:00:00Z'));
    expect(s.remainingCents).toBe(-100_000);
    expect(s.sustainableWeeklyCents).toBe(0);
    expect(s.projectedRunOutDate).toBeNull(); // already out — nothing to project
    expect(s.runsOutBeforeEnd).toBe(true);
  });
});

describe('computeRunwayMonths', () => {
  it('divides net liquid cash by average monthly spending', () => {
    expect(computeRunwayMonths(1_200_000, 250_000)).toBe(4.8);
  });

  it('is null when there is no spending history to divide by', () => {
    expect(computeRunwayMonths(1_200_000, 0)).toBeNull();
    expect(computeRunwayMonths(1_200_000, -50)).toBeNull();
  });

  it('clamps a negative liquid position to zero months', () => {
    expect(computeRunwayMonths(-40_000, 250_000)).toBe(0);
  });
});

describe('parsePoolConfig', () => {
  it('round-trips a valid stored config', () => {
    expect(parsePoolConfig(JSON.stringify(cfg))).toEqual(cfg);
  });

  it('rejects malformed JSON, missing fields, bad dates, and non-positive amounts', () => {
    expect(parsePoolConfig(null)).toBeNull();
    expect(parsePoolConfig('not json')).toBeNull();
    expect(parsePoolConfig('{}')).toBeNull();
    expect(parsePoolConfig(JSON.stringify({ ...cfg, amountCents: 0 }))).toBeNull();
    expect(parsePoolConfig(JSON.stringify({ ...cfg, endDate: '12/12/2026' }))).toBeNull();
    // End before start is a config that can only mislead — refuse it whole.
    expect(parsePoolConfig(JSON.stringify({ ...cfg, endDate: '2026-08-01' }))).toBeNull();
  });
});
