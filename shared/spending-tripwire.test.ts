import { describe, it, expect } from 'vitest';
import { snapshotTripwire, spendingTripwire, tripwireFinding, tripwireLine, TRIPWIRE_TOLERANCE_CENTS } from './spending-tripwire.js';
import { formatFindingsSummary, formatSelfCheckBlock, printsInFull } from './self-check.js';
import { isSnoozable } from './findings.js';
import { buildAuditSnapshot, parseAuditSnapshot } from './audit-snapshot.js';
import { explainBalances } from './audit-balance.js';
import { explainHeadline } from './audit-headline.js';
import { healthIssues } from './audit-health.js';

const NOW = new Date(2026, 9, 14, 8, 0);
const h = (reportCents: number | null, wealthfolioCents: number | null, month = '2026-10', reasons: any[] | null = []) => ({ month, reportCents, wealthfolioCents, reasons });
const notCovered = (cents: number) => ({ kind: 'not-covered', cents, rows: [] });

describe('spendingTripwire', () => {
  it('agrees when the two are equal, or a cent apart either way', () => {
    expect(TRIPWIRE_TOLERANCE_CENTS).toBe(1);
    for (const [r, w] of [[324351, 324351], [324352, 324351], [324351, 324352]]) {
      expect(spendingTripwire(h(r, w), NOW)).toEqual({ kind: 'agree' });
    }
  });

  it('differs at two cents, either way, and says by how much', () => {
    expect(spendingTripwire(h(324353, 324351), NOW)).toEqual({ kind: 'differ', month: '2026-10', diffCents: 2 });
    const t = spendingTripwire(h(229206, 324351), NOW);
    expect(t).toEqual({ kind: 'differ', month: '2026-10', diffCents: -95145 });
    expect(tripwireLine(t)).toBe('The report and Wealthfolio differ by $951.45 this month');
  });

  it('makes no claim when a figure is unread, or the comparison is another month’s', () => {
    for (const t of [h(null, 120000), h(130000, null), h(null, null), h(130000, 120000, '2026-09')]) {
      expect(spendingTripwire(t, NOW)).toEqual({ kind: 'unknown' });
      expect(tripwireLine(spendingTripwire(t, NOW))).toBeNull();
    }
    expect(spendingTripwire(null, NOW)).toEqual({ kind: 'unknown' });
  });

  it('compares what the report covers: an unsynced account\u2019s gap is explained, not warned about (LU-J)', () => {
    expect(spendingTripwire(h(100000, 102000, '2026-10', [notCovered(-2000)]), NOW)).toEqual({ kind: 'agree' });
    const t = spendingTripwire(h(100000, 102500, '2026-10', [notCovered(-2000)]), NOW);
    expect(t).toEqual({ kind: 'differ', month: '2026-10', diffCents: -500 });
    expect(tripwireLine(t)).toBe('The report and Wealthfolio differ by $5.00 this month');
    const fx = { kind: 'foreign-currency', cents: -2000, rows: [] };
    expect(spendingTripwire(h(100000, 102000, '2026-10', [fx]), NOW)).toMatchObject({ kind: 'differ', diffCents: -2000 });
    expect(spendingTripwire(h(100000, 102000, '2026-10', null), NOW)).toEqual({ kind: 'unknown' });
  });

  it('reads the published snapshot; an absent or corrupt one makes no claim', () => {
    const snap = (reportCents: number, wealthfolioCents: number) => parseAuditSnapshot(JSON.stringify(buildAuditSnapshot({
      balances: explainBalances({}),
      headline: explainHeadline({ month: '2026-10', reportCents, wealthfolioCents, rows: [] }),
      health: healthIssues({}),
    }, NOW)));
    expect(snapshotTripwire(snap(130000, 120000), NOW)).toMatchObject({ kind: 'differ', diffCents: 10000 });
    expect(snapshotTripwire(snap(120000, 120000), NOW)).toEqual({ kind: 'agree' });
    expect(snapshotTripwire({ kind: 'absent' }, NOW)).toEqual({ kind: 'unknown' });
    expect(snapshotTripwire({ kind: 'corrupt' }, NOW)).toEqual({ kind: 'unknown' });
    expect(snapshotTripwire(null, NOW)).toEqual({ kind: 'unknown' });
  });
});

describe('the daily report’s line', () => {
  it('is a warning printed in full — never folded, never snoozed — with the exact words', () => {
    const f = tripwireFinding(spendingTripwire(h(324353, 324351), NOW))!;
    expect(f).toEqual({ kind: 'spending-differs', severity: 'warning', message: 'The report and Wealthfolio differ by $0.02 this month — /audit explains' });
    expect(printsInFull(f)).toBe(true);
    expect(isSnoozable(f)).toBe(false);
    expect(formatFindingsSummary([f])).toBe('*Needs attention*\n⚠️ The report and Wealthfolio differ by $0.02 this month — /audit explains');
    expect(formatSelfCheckBlock([f])).toContain('⚠️ The report and Wealthfolio differ by $0.02 this month — /audit explains');
  });

  it('is not there when the two agree, or a figure was not read', () => {
    expect(tripwireFinding(spendingTripwire(h(324352, 324351), NOW))).toBeNull();
    expect(tripwireFinding(spendingTripwire(h(null, 324351), NOW))).toBeNull();
  });
});
