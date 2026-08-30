import { describe, it, expect } from 'vitest';
import { evaluateCustomReport, parseCustomReports, newCustomReportId, type CustomReport } from './report-eval.js';
import { CUBE } from './report-cube.test.js';

const def = (over: Partial<CustomReport> = {}): CustomReport => ({
  id: 'cr-1', name: 'Food', chart: 'line', range: { kind: 'all' }, accounts: null,
  series: [{ label: 'Food', terms: [
    { sign: 1, source: 'category', category: 'Dining' },
    { sign: 1, source: 'category', category: 'Groceries' },
  ] }],
  ...over,
});

describe('evaluateCustomReport', () => {
  it('adds category series per month', () => {
    const r = evaluateCustomReport(CUBE, def());
    expect(r.months).toEqual(['2026-07', '2026-08']);
    expect(r.series[0].values).toEqual([6000, 4500]);
    expect(r.series[0].unknownCategories).toEqual([]);
  });

  it('subtracts, mixes sources, and honors account filters', () => {
    const r = evaluateCustomReport(CUBE, def({
      accounts: ['sfin-1'],
      series: [{ label: 'Cash surplus', terms: [
        { sign: 1, source: 'income' },
        { sign: -1, source: 'spending' },
      ] }],
    }));
    // sfin-1 — Jul: income 50,000 − (1000 + 3000 + 100); Aug: 0 − 1500.
    expect(r.series[0].values).toEqual([45_900, -1500]);
  });

  it('clips the month window for range months:n', () => {
    const r = evaluateCustomReport(CUBE, def({ range: { kind: 'months', n: 1 } }));
    expect(r.months).toEqual(['2026-08']);
    expect(r.series[0].values).toEqual([4500]);
  });

  it('uses the pool window for range pool, and the whole cube when no pool is set', () => {
    // CUBE.pool is null, so 'pool' degrades to all months rather than to nothing.
    const r = evaluateCustomReport(CUBE, def({ range: { kind: 'pool' } }));
    expect(r.months).toEqual(['2026-07', '2026-08']);
    const pooled = {
      ...CUBE,
      pool: {
        config: { amountCents: 1, startDate: '2026-08-01', endDate: '2026-08-31' },
        daily: [],
      },
    };
    expect(evaluateCustomReport(pooled, def({ range: { kind: 'pool' } })).months).toEqual(['2026-08']);
  });

  it('scores an unknown category as zero and names it', () => {
    const r = evaluateCustomReport(CUBE, def({
      series: [{ label: 'X', terms: [{ sign: 1, source: 'category', category: 'Ghost' }] }],
    }));
    expect(r.series[0].values).toEqual([0, 0]);
    expect(r.series[0].unknownCategories).toEqual(['Ghost']);
  });
});

describe('parseCustomReports', () => {
  it('round-trips and rejects malformed entries individually', () => {
    const good = def();
    const raw = JSON.stringify([good, { id: 'bad' }, 42]);
    expect(parseCustomReports(raw)).toEqual([good]);
    expect(parseCustomReports(null)).toEqual([]);
    expect(parseCustomReports('junk')).toEqual([]);
  });
  it('rejects a report whose term names no category for the category source', () => {
    const bad = def({ series: [{ label: 'X', terms: [{ sign: 1, source: 'category' } as any] }] });
    expect(parseCustomReports(JSON.stringify([bad]))).toEqual([]);
  });
});

it('newCustomReportId is cr-prefixed and unique-ish', () => {
  const a = newCustomReportId();
  const b = newCustomReportId();
  expect(a).toMatch(/^cr-[0-9a-f]{12}$/);
  expect(a).not.toBe(b);
});
