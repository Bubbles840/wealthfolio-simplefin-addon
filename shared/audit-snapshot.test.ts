import { describe, it, expect } from 'vitest';
import {
  auditSnapshotStatus, buildAuditSnapshot, parseAuditSnapshot, AUDIT_CORRUPT, AUDIT_NEEDS_COMPANION, AUDIT_NOT_YET,
  AUDIT_SNAPSHOT_MAX_BYTES, AUDIT_SNAPSHOT_SECRET_KEY, type AuditResults,
} from './audit-snapshot';
import { HEADLINE_REASON_KINDS, type HeadlineRow } from './audit-headline';
import type { BalanceExplanation } from './audit-balance';
import type { HealthIssue, HealthLeg } from './audit-health';

const bytes = (s: string) => new TextEncoder().encode(s).length;
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const NOW = new Date('2026-10-13T18:00:00Z');

function account(i: number): BalanceExplanation {
  return {
    wfAccountId: uuid(i), name: `${'Ü'.repeat(56)} ${i}`, accountType: 'CREDIT_CARD',
    bank: { kind: 'ok', cents: -123456789, date: '2026-10-13' }, wealthfolioCents: -123400000, offCents: -56789,
    causes: [
      { kind: 'pending', cents: -1, count: 99 }, { kind: 'after-bank-date', cents: -2, count: 99 }, { kind: 'held', cents: -3, count: 1 },
      { kind: 'unlinked', cents: -4, count: 1 }, { kind: 'not-booked', cents: -5, count: 99 },
    ],
    unexplainedCents: -56774,
    includes: { start: { cents: -99999999, date: '2024-01-01' }, corrections: { count: 99, cents: -9999999, latest: '2026-10-12' } },
  };
}
const headlineRow = (i: number): HeadlineRow => ({ date: '2026-10-01', description: `${'Ü'.repeat(110)} ${i}`, cents: -123456, account: 'Ü'.repeat(60) });
const leg = (i: number): HealthLeg => ({
  activityId: uuid(i), accountId: uuid(i + 1), accountName: 'Ü'.repeat(60), txKey: `${uuid(i + 2)}\u0000TRN-${'9'.repeat(40)}`,
  date: '2026-10-04', absCents: 123456789, type: 'TRANSFER_OUT', currency: 'USD', description: 'Ü'.repeat(110),
});

/** Every list as long as a bad year could make it, every string at its longest. */
function worstCase(): AuditResults {
  const issues: HealthIssue[] = Array.from({ length: 1000 }, (_, i) => ({
    kind: 'incomplete-leg', key: `leg:${uuid(i)}`, leg: leg(i), problem: { kind: 'legs', count: 3 }, owner: 'you', match: 'one', counterpart: leg(i + 5000),
  }));
  return {
    balances: { accounts: Array.from({ length: 40 }, (_, i) => account(i)), notes: ["Couldn't read the bank balances."] },
    headline: {
      month: '2026-10', reportCents: 999999999, wealthfolioCents: 1, unexplainedCents: 1, notes: ["Couldn't read Wealthfolio's settings."],
      reasons: HEADLINE_REASON_KINDS.map((kind) => ({ kind, cents: 999999, rows: Array.from({ length: 2000 }, (_, i) => headlineRow(i)) })),
    },
    health: { issues, notes: [] },
  };
}

function small(): AuditResults {
  return {
    balances: { accounts: [account(1)], notes: [] },
    headline: { month: '2026-10', reportCents: 100, wealthfolioCents: 90, unexplainedCents: 0, notes: [], reasons: [{ kind: 'future', cents: 10, rows: [headlineRow(1)] }] },
    health: { issues: [], notes: [] },
  };
}

describe('buildAuditSnapshot', () => {
  it('is the secret the companion writes and the app reads', () => {
    expect(AUDIT_SNAPSHOT_SECRET_KEY).toBe('audit_snapshot');
  });

  it('keeps a worst case within budget by trimming rows first, saying how many it left out', () => {
    const snap = buildAuditSnapshot(worstCase(), NOW);
    expect(bytes(JSON.stringify(snap))).toBeLessThanOrEqual(AUDIT_SNAPSHOT_MAX_BYTES);
    expect(Object.keys(snap.balances)).toHaveLength(40);
    for (const r of snap.headline.reasons!) {
      expect(r.more).toBeGreaterThan(0);
      expect(r.rows.length + r.more!).toBe(2000);
    }
    expect(snap.health.more).toBeGreaterThan(0);
    expect(snap.health.issues!.length + snap.health.more!).toBe(1000);
  });

  it('leaves a small snapshot whole, keyed by account in mapping order', () => {
    const snap = buildAuditSnapshot(small(), NOW);
    expect(snap).toEqual({
      v: 1, at: '2026-10-13T18:00:00.000Z', balances: { [uuid(1)]: account(1) }, balanceNotes: [],
      headline: small().headline, health: small().health,
    });
  });
});

describe('parseAuditSnapshot', () => {
  it('reads back what the companion wrote', () => {
    const snap = buildAuditSnapshot(small(), NOW);
    expect(parseAuditSnapshot(JSON.stringify(snap))).toEqual({ kind: 'ok', snapshot: snap });
  });

  it('is absent when nothing was published', () => {
    expect(parseAuditSnapshot(null)).toEqual({ kind: 'absent' });
    expect(parseAuditSnapshot(undefined)).toEqual({ kind: 'absent' });
    expect(parseAuditSnapshot('')).toEqual({ kind: 'absent' });
  });

  it('is corrupt — never empty — when it cannot be read', () => {
    const good = buildAuditSnapshot(small(), NOW);
    for (const raw of [
      '{not json',
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, at: 'yesterday' }),
      JSON.stringify({ ...good, balances: [] }),
      JSON.stringify({ ...good, balances: { x: { name: 'A' } } }),
      JSON.stringify({ ...good, headline: { ...good.headline, reasons: [{ kind: 'future', cents: 1 }] } }),
      JSON.stringify({ ...good, health: { issues: 'none', notes: [] } }),
      JSON.stringify({ ...good, health: { issues: [{ kind: 'late-start' }], notes: [] } }),
      'null',
    ]) {
      expect(parseAuditSnapshot(raw)).toEqual({ kind: 'corrupt' });
    }
  });
});

describe('auditSnapshotStatus', () => {
  const at = new Date(2026, 9, 13, 14, 0);
  const ok = parseAuditSnapshot(JSON.stringify(buildAuditSnapshot(small(), at)));

  it('says when a fresh snapshot was taken, in the viewer’s own time', () => {
    expect(auditSnapshotStatus(ok, '1.61.0', new Date(2026, 9, 13, 18, 30))).toEqual({ state: 'fresh', line: 'As of the 2:00 PM sync.' });
    expect(auditSnapshotStatus(ok, '1.61.0', new Date(2026, 9, 14, 9, 0))).toEqual({ state: 'fresh', line: 'As of the Oct 13, 2:00 PM sync.' });
  });

  it('says a snapshot older than two days is from that day', () => {
    expect(auditSnapshotStatus(ok, '1.61.0', new Date(2026, 9, 15, 14, 0, 1))).toEqual({
      state: 'stale', line: "These checks are from Oct 13 — the companion hasn't synced since.",
    });
  });

  it('tells a missing companion from one that has not published yet, and a corrupt snapshot from both', () => {
    expect(auditSnapshotStatus({ kind: 'absent' }, null, at)).toEqual({ state: 'absent', line: AUDIT_NEEDS_COMPANION });
    expect(auditSnapshotStatus({ kind: 'absent' }, '1.60.0', at)).toEqual({ state: 'absent', line: AUDIT_NOT_YET });
    expect(auditSnapshotStatus({ kind: 'corrupt' }, '1.61.0', at)).toEqual({ state: 'corrupt', line: AUDIT_CORRUPT });
    expect(AUDIT_CORRUPT).toBe("Couldn't read the checks — run /audit in Telegram.");
    expect(AUDIT_NEEDS_COMPANION).toBe('These checks need the companion.');
  });
});
