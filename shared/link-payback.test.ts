import { describe, it, expect } from 'vitest';
import { healthIssues, type HealthFacts, type HealthIssue, type HealthLeg } from './audit-health';
import type { AuditAccount, AuditLedgerRow } from './audit-ledger';
import { checkLinkPair, LINK_PAYBACK, type LinkPair, type ReadRow } from './audit-link';
import type { FixRow } from './fix-row';
import { emptySyncOverrides, setTxOverride } from './sync-overrides';
import { accountTxKey } from './transfers';

const NOW = new Date('2026-10-14T15:00:00Z');
const OUT_KEY = accountTxKey('sfin-ally', 'TRN-1');
const IN_KEY = accountTxKey('sfin-chk', 'TRN-77');
const OUT: HealthLeg = {
  activityId: 'out-1', accountId: 'wf-ally', accountName: 'Ally Savings', txKey: OUT_KEY, date: '2026-10-08', absCents: 1400,
  type: 'TRANSFER_OUT', currency: 'USD', description: 'TRANSFER TO PNC',
};
const PAYBACK: HealthLeg = {
  activityId: 'act-7', accountId: 'wf-chk', accountName: 'PNC Checking', txKey: IN_KEY, date: '2026-10-09', absCents: 1400,
  type: 'CREDIT', currency: 'USD', description: 'VENMO CASHOUT',
};
const PAIR: LinkPair = { key: 'leg:out-1', leg: OUT, counterpart: PAYBACK };
const row = (l: HealthLeg, over: Partial<FixRow> = {}): FixRow => ({
  id: l.activityId, accountId: l.accountId, accountName: l.accountName, accountType: 'CASH', type: l.type, date: l.date,
  absCents: l.absCents, feeCents: 0, currency: 'USD', notes: `${l.description} · ${l.txKey!.split('\u0000')[1]}`,
  subtype: null, flowExternal: null, grouped: false, ...over,
});
const read = (b: Partial<FixRow> = {}): [ReadRow, ReadRow] => [{ row: row(OUT), linked: false }, { row: row(PAYBACK, b), linked: false }];
const flagged = setTxOverride(emptySyncOverrides(), IN_KEY, 'asReimbursement', NOW, { label: 'VENMO CASHOUT · PNC Checking' });

describe('Link never takes a payback for half of a transfer (1.62)', () => {
  it('refuses a row the payback setting is on, in its own words', () => {
    expect(checkLinkPair(PAIR, read(), flagged)).toEqual({ ok: false, reason: LINK_PAYBACK });
    expect(LINK_PAYBACK).toBe('One of these is a payback, not half of a transfer — nothing was linked.');
  });

  it('refuses a cash CREDIT marked REIMBURSEMENT with no setting (a payback rule typed it)', () => {
    expect(checkLinkPair(PAIR, read({ subtype: 'REIMBURSEMENT' }), emptySyncOverrides())).toEqual({ ok: false, reason: LINK_PAYBACK });
  });

  it('still links a plain CREDIT, and a card credit marked REIMBURSEMENT', () => {
    expect(checkLinkPair(PAIR, read(), emptySyncOverrides()).ok).toBe(true);
    expect(checkLinkPair(PAIR, read({ subtype: 'REIMBURSEMENT', accountType: 'CREDIT_CARD' }), emptySyncOverrides()).ok).toBe(true);
  });
});

describe("Health never offers a payback as a transfer's other half (1.62)", () => {
  const acct = (id: string, name: string): AuditAccount => ({ id, name, type: 'CASH', archived: false, active: true });
  const ledgerRow = (over: Partial<AuditLedgerRow>): AuditLedgerRow => ({
    id: 'r', accountId: 'wf-chk', date: '2026-10-08', currency: 'USD', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', status: 'POSTED',
    absCents: 1400, group: '', assetId: '', external: false, phantomCash: false, notes: '', ...over,
  });
  const facts = (over: Partial<HealthFacts> = {}): HealthFacts => ({
    ledger: {
      accounts: [acct('wf-chk', 'PNC Checking'), acct('wf-ally', 'Ally Savings')],
      rows: [
        ledgerRow({ id: 'out-1', accountId: 'wf-ally', notes: 'TRANSFER TO PNC · TRN-1' }),
        ledgerRow({ id: 'act-7', accountId: 'wf-chk', rawType: 'CREDIT', type: 'CREDIT', date: '2026-10-09', notes: 'VENMO CASHOUT · TRN-77' }),
      ],
    },
    mapping: { 'sfin-chk': 'wf-chk', 'sfin-ally': 'wf-ally' },
    ...over,
  });
  const leg = (issues: HealthIssue[] | null) => (issues ?? []).find((i) => i.kind === 'incomplete-leg' && i.leg.activityId === 'out-1');

  it('skips a row the payback setting is on', () => {
    expect(leg(healthIssues(facts()).issues)).toMatchObject({ match: 'one', counterpart: expect.objectContaining({ activityId: 'act-7' }) });
    expect(leg(healthIssues(facts({ overrides: flagged })).issues)).toMatchObject({ match: 'none', counterpart: null });
  });
});
