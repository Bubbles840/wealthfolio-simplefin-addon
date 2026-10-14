import { describe, it, expect } from 'vitest';
import {
  auditSnapshotStatus, buildAuditSnapshot, parseAuditSnapshot, AUDIT_CORRUPT, AUDIT_NEEDS_COMPANION, AUDIT_NOT_YET,
  AUDIT_SNAPSHOT_MAX_BYTES, AUDIT_SNAPSHOT_SECRET_KEY, type AuditResults,
} from './audit-snapshot';
import { HEADLINE_REASON_KINDS, type HeadlineRow } from './audit-headline';
import type { BalanceExplanation } from './audit-balance';
import { healthIssues, type HealthIssue, type HealthLeg } from './audit-health';
import { explainBalances, type BalanceFacts } from './audit-balance';
import { explainHeadline } from './audit-headline';
import type { AuditAccount, AuditLedgerRow } from './audit-ledger';

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
    headline: { month: '2026-10', reportCents: 100, wealthfolioCents: 90, unexplainedCents: 0, notes: [], reasons: [{ kind: 'first-midnight', cents: 10, rows: [headlineRow(1)] }] },
    health: { issues: [], notes: [] },
  };
}

describe('buildAuditSnapshot', () => {
  it('is the secret the companion writes and the app reads', () => {
    expect(AUDIT_SNAPSHOT_SECRET_KEY).toBe('audit_snapshot');
  });

  it('keeps a worst case within budget by trimming rows first, saying how many it left out', () => {
    const snap = buildAuditSnapshot(worstCase(), NOW)!;
    expect(bytes(JSON.stringify(snap))).toBeLessThanOrEqual(AUDIT_SNAPSHOT_MAX_BYTES);
    expect(Object.keys(snap.balances)).toHaveLength(40);
    for (const r of snap.headline.reasons!) {
      expect(r.more).toBeGreaterThan(0);
      expect(r.rows.length + r.more!).toBe(2000);
    }
    expect(snap.health.more).toBeGreaterThan(0);
    expect(snap.health.issues!.length + snap.health.more!).toBe(1000);
  });

  it('caps an oversized notes list so the snapshot fits', () => {
    const r = small();
    r.balances.notes = Array.from({ length: 500 }, (_, i) => `${'n'.repeat(400)} ${i}`);
    const snap = buildAuditSnapshot(r, NOW)!;
    expect(bytes(JSON.stringify(snap))).toBeLessThanOrEqual(AUDIT_SNAPSHOT_MAX_BYTES);
    expect(snap.balanceNotes).toHaveLength(4);
    expect(snap.balanceNotes[3]).toBe('and 497 more');
  });

  it('returns null when it cannot fit, so nothing oversize is published', () => {
    const r = small();
    r.balances.accounts = Array.from({ length: 40 }, (_, i) => ({ ...account(i), name: 'Ü'.repeat(3000) }));
    expect(buildAuditSnapshot(r, NOW)).toBeNull();
  });

  it('counts bytes, not characters: 3-byte text under 100,000 characters still trims', () => {
    const r = small();
    r.headline.reasons = [{ kind: 'double-filed', cents: 1, rows: Array.from({ length: 400 }, (_, i) => ({ ...headlineRow(i), description: '€'.repeat(110) })) }];
    const chars = JSON.stringify(r).length;
    expect(chars).toBeLessThan(AUDIT_SNAPSHOT_MAX_BYTES);
    expect(bytes(JSON.stringify(r))).toBeGreaterThan(AUDIT_SNAPSHOT_MAX_BYTES);
    const snap = buildAuditSnapshot(r, NOW)!;
    expect(bytes(JSON.stringify(snap))).toBeLessThanOrEqual(AUDIT_SNAPSHOT_MAX_BYTES);
    expect(snap.headline.reasons![0].more).toBeGreaterThan(0);
  });

  it('leaves a small snapshot whole, keyed by account in mapping order', () => {
    const snap = buildAuditSnapshot(small(), NOW)!;
    expect(snap).toEqual({
      v: 1, at: '2026-10-13T18:00:00.000Z', balances: { [uuid(1)]: account(1) }, balanceNotes: [],
      headline: small().headline, health: small().health,
    });
  });
});

describe('parseAuditSnapshot', () => {
  it('reads back what the companion wrote', () => {
    const snap = buildAuditSnapshot(small(), NOW)!;
    expect(parseAuditSnapshot(JSON.stringify(snap))).toEqual({ kind: 'ok', snapshot: snap });
  });

  it('is absent when nothing was published', () => {
    expect(parseAuditSnapshot(null)).toEqual({ kind: 'absent' });
    expect(parseAuditSnapshot(undefined)).toEqual({ kind: 'absent' });
    expect(parseAuditSnapshot('')).toEqual({ kind: 'absent' });
  });

  it('is corrupt — never empty — when it cannot be read', () => {
    const good = buildAuditSnapshot(small(), NOW)!;
    for (const raw of [
      '{not json',
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, at: 'yesterday' }),
      JSON.stringify({ ...good, balances: [] }),
      JSON.stringify({ ...good, balances: { x: { name: 'A' } } }),
      JSON.stringify({ ...good, headline: { ...good.headline, reasons: [{ kind: 'excluded', cents: 1 }] } }),
      JSON.stringify({ ...good, health: { issues: 'none', notes: [] } }),
      JSON.stringify({ ...good, health: { issues: [{ kind: 'late-start' }], notes: [] } }),
      'null', '[]', '5', '"text"',
      JSON.stringify({ ...good, at: undefined }),
      JSON.stringify({ ...good, balanceNotes: undefined }),
      JSON.stringify({ ...good, health: { issues: [{ kind: 'x', key: 'k' }], notes: [] } }),
      JSON.stringify({ ...good, health: { issues: [{ kind: 'incomplete-leg', key: 'k' }], notes: [] } }),
      JSON.stringify({ ...good, health: { issues: [{ kind: 'incomplete-leg', key: 'k', leg: { activityId: 'a', accountId: 'b', absCents: 'x' } }], notes: [] } }),
      JSON.stringify({ ...good, health: { issues: [{ kind: 'incomplete-leg', key: 'k', leg: { activityId: 'a', accountId: 'b', absCents: 1 }, counterpart: {} }], notes: [] } }),
      JSON.stringify({ ...good, headline: { ...good.headline, reasons: [{ kind: 'excluded', cents: 1, rows: [{ date: 'x' }] }] } }),
      JSON.stringify({ ...good, balances: { [uuid(1)]: { ...account(1), causes: [{ kind: 'pending' }] } } }),
      JSON.stringify({ ...good, balances: { [uuid(1)]: { ...account(1), causes: [5] } } }),
      JSON.stringify({ ...good, balances: { [uuid(1)]: { ...account(1), offCents: 'x' } } }),
      JSON.stringify({ ...good, balances: { [uuid(2)]: account(1) } }),
      JSON.stringify({ ...good, health: { issues: [{ kind: 'late-start', key: 'k', activityId: 1, accountId: 'b', cents: 'x' }], notes: [] } }),
      JSON.stringify({ ...good, health: { issues: [{ kind: 'phantom-cash', key: 'k', rows: 'x', accounts: 'y' }], notes: [] } }),
      JSON.stringify({ ...good, health: { issues: [{ kind: 'incomplete-leg', key: 'k', leg: { absCents: 1 } }], notes: [] } }),
    ]) {
      expect(parseAuditSnapshot(raw)).toEqual({ kind: 'corrupt' });
    }
  });

  it('is corrupt when a date the views read is missing or not a date, or a kind they cannot name', () => {
    const good = buildAuditSnapshot(small(), NOW)!;
    const acct = account(1);
    const goodLeg = leg(1);
    const issue = (over: Record<string, unknown>) => JSON.stringify({ ...good, health: { issues: [over], notes: [] } });
    const legIssue = { kind: 'incomplete-leg', key: 'k', problem: null, owner: 'you', match: 'one', leg: goodLeg, counterpart: goodLeg };
    const lateStart = { kind: 'late-start', key: 'k', activityId: 'a', accountId: 'b', accountName: 'C', date: '2026-10-02', earliest: '2026-10-01', cents: 1 };
    const balance = (over: Partial<BalanceExplanation> | Record<string, unknown>) => JSON.stringify({ ...good, balances: { [uuid(1)]: { ...acct, ...over } } });
    const reasonRows = (rows: unknown[], kind = 'first-midnight') => JSON.stringify({ ...good, headline: { ...good.headline, reasons: [{ kind, cents: 1, rows }] } });
    // Each of these is well-formed but for the one field.
    expect(parseAuditSnapshot(issue(legIssue)).kind).toBe('ok');
    expect(parseAuditSnapshot(issue(lateStart)).kind).toBe('ok');
    for (const raw of [
      reasonRows([{ description: 'A', cents: 1, account: 'B' }]),
      reasonRows([{ date: 20261001, description: 'A', cents: 1, account: 'B' }]),
      reasonRows([{ date: 'soon', description: 'A', cents: 1, account: 'B' }]),
      reasonRows([], 'future'),
      issue({ ...legIssue, leg: { ...goodLeg, date: undefined } }),
      issue({ ...legIssue, counterpart: { ...goodLeg, date: 5 } }),
      issue({ ...lateStart, date: null }),
      issue({ ...lateStart, earliest: 'x' }),
      balance({ bank: { kind: 'ok', cents: 1, date: 5 } }),
      balance({ bank: { kind: 'ok', cents: 'x', date: null } }),
      balance({ bank: { kind: 'maybe' } }),
      balance({ includes: { start: { cents: 1 }, corrections: null } }),
      balance({ includes: { start: null, corrections: { count: 1, cents: 1, latest: 7 } } }),
      balance({ includes: 'none' }),
    ]) {
      expect(parseAuditSnapshot(raw)).toEqual({ kind: 'corrupt' });
    }
    // The bank's date may be null, and an account need not carry includes.
    expect(parseAuditSnapshot(balance({ bank: { kind: 'ok', cents: 1, date: null }, includes: null })).kind).toBe('ok');
    expect(parseAuditSnapshot(balance({ bank: { kind: 'none' } })).kind).toBe('ok');
  });
});

describe('auditSnapshotStatus', () => {
  const at = new Date(2026, 9, 13, 14, 0);
  const ok = parseAuditSnapshot(JSON.stringify(buildAuditSnapshot(small(), at)!));

  it('says when a fresh snapshot was taken, in the viewer’s own time', () => {
    expect(auditSnapshotStatus(ok, '1.61.0', new Date(2026, 9, 13, 18, 30))).toEqual({ state: 'fresh', line: 'As of the 2:00 PM sync.' });
    expect(auditSnapshotStatus(ok, '1.61.0', new Date(2026, 9, 14, 9, 0))).toEqual({ state: 'fresh', line: 'As of the Oct 13, 2:00 PM sync.' });
  });

  it('says a snapshot older than two days is from that day', () => {
    expect(auditSnapshotStatus(ok, '1.61.0', new Date(2026, 9, 15, 14, 0, 0)).state).toBe('fresh');
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

describe('round trip through the real builders', () => {
  const acct = (id: string, name: string, type = 'CASH'): AuditAccount => ({ id, name, type, archived: false });
  let seq = 0;
  const row = (over: Partial<AuditLedgerRow> = {}): AuditLedgerRow => {
    seq += 1;
    return {
      id: `act-${seq}`, accountId: 'wf-a', date: '2026-10-04', currency: 'USD', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL',
      status: 'POSTED', absCents: 1000, group: '', assetId: '', external: false, phantomCash: false, notes: `ROW · TRN-${seq}`, ...over,
    };
  };
  const ledger = {
    accounts: [acct('wf-a', 'A'), acct('wf-b', 'B'), acct('wf-c', 'C')],
    rows: [
      row({ rawType: 'DEPOSIT', type: 'DEPOSIT', absCents: 50000, date: '2026-09-01', notes: 'Starting balance · ACT-1' }),
      row({ accountId: 'wf-c', rawType: 'DEPOSIT', type: 'DEPOSIT', absCents: 5000, date: '2026-09-10', notes: 'Starting balance · ACT-3' }),
      row({ accountId: 'wf-c', date: '2026-09-02', notes: 'EARLY · TRN-90' }),
      // an incomplete leg with one counterpart, and one with two candidates (null counterpart)
      row({ id: 'out1', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', absCents: 7000, notes: 'TO B · TRN-91' }),
      row({ id: 'in1', accountId: 'wf-b', rawType: 'DEPOSIT', type: 'DEPOSIT', absCents: 7000, notes: 'FROM A · TRN-92' }),
      row({ id: 'out2', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', absCents: 9000, notes: 'TO ? · TRN-93' }),
      row({ accountId: 'wf-b', rawType: 'DEPOSIT', type: 'DEPOSIT', absCents: 9000, notes: 'X · TRN-94' }),
      row({ accountId: 'wf-c', rawType: 'DEPOSIT', type: 'DEPOSIT', absCents: 9000, notes: 'Y · TRN-95' }),
      row({ accountId: 'wf-b', rawType: 'DEPOSIT', type: 'DEPOSIT', absCents: 100, phantomCash: true, notes: 'OLD · TRN-96' }),
      row({ notes: 'LUNCH · TRN-97 · pending', absCents: 500 }),
    ],
  };
  const mapping = { 's-a': 'wf-a', 's-b': 'wf-b', 's-c': 'wf-c' };
  const balanceFacts: BalanceFacts = {
    mapping, ledger, names: { 's-a': 'Bank A' },
    balances: { 's-a': { balance: 400, date: 1760000000 } }, // b, c: bank sent none
    valuations: { 'wf-a': 39000, 'wf-b': 1 },
  };
  const noLedger: BalanceFacts = { mapping, names: {}, failed: ['ledger', 'balances', 'valuations'] };
  const rows = [
    { id: 'h1', date: '2026-10-01T00:00:00+00:00', accountId: 'wf-a', groupId: '', accountName: 'A', accountType: 'CASH', type: 'WITHDRAWAL', subtype: '', absCents: 100, notes: 'RENT · TRN-1', spendingFilings: 2, categoryIds: ['c', 'd'] },
    { id: 'h2', date: '2026-10-03T00:00:00+00:00', accountId: 'wf-a', groupId: '', accountName: 'A', accountType: 'CASH', type: 'CREDIT', subtype: 'REFUND', absCents: 200, notes: 'RETURN · TRN-2', spendingFilings: 0, categoryIds: [] },
    { id: 'h3', date: '2026-10-05T00:00:00+00:00', accountId: 'wf-a', groupId: '', accountName: 'A', accountType: 'CASH', type: 'DEPOSIT', subtype: '', absCents: 300, notes: 'REFUND · TRN-3', spendingFilings: 0, categoryIds: [] },
  ];

  it('parses a snapshot of real results as ok, nulls and all', () => {
    const full = {
      balances: explainBalances(balanceFacts),
      headline: explainHeadline({ month: '2026-10', timezone: 'America/New_York', reportCents: 5000, wealthfolioCents: 4000, rows }),
      health: healthIssues({ ledger, mapping }),
    };
    const kinds = new Set(full.health.issues!.map((i) => i.kind));
    expect([...kinds].sort()).toEqual(['incomplete-leg', 'late-start', 'phantom-cash']);
    const legs = full.health.issues!.flatMap((i) => (i.kind === 'incomplete-leg' ? [i] : []));
    expect(legs.some((l) => l.counterpart === null)).toBe(true);
    expect(legs.some((l) => l.counterpart !== null)).toBe(true);
    expect(full.balances.accounts.map((a) => a.bank.kind)).toContain('none');
    expect(full.balances.accounts.map((a) => a.bank.kind)).toContain('ok');

    const degraded = {
      balances: explainBalances(noLedger),
      headline: explainHeadline({ month: '2026-10', failed: ['ledger', 'report', 'wealthfolio'] }),
      health: healthIssues({ mapping, failed: ['ledger'] }),
    };
    const accs = degraded.balances.accounts;
    expect(accs.map((a) => a.bank.kind)).toContain('unread');
    expect(accs.every((a) => a.causes === null && a.offCents === null && a.unexplainedCents === null && a.includes === null)).toBe(true);
    expect(degraded.headline.reasons).toBeNull();
    expect(degraded.health.issues).toBeNull();

    for (const results of [full, degraded]) {
      const snap = buildAuditSnapshot(results, NOW)!;
      expect(parseAuditSnapshot(JSON.stringify(snap))).toEqual({ kind: 'ok', snapshot: snap });
    }
  });
});
