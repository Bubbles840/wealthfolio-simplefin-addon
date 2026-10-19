import { describe, it, expect } from 'vitest';
import type { AuditAccount, AuditLedger, AuditLedgerRow } from './audit-ledger.js';
import { learnTransferNames } from './learn-transfer-names.js';
import { emptySyncOverrides, setTxOverride } from './sync-overrides.js';
import { IN_TRANSIT_COMMENT_PREFIX } from './sync-core.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-18T15:00:00Z');
const SAVINGS_TO_SPEND = 'RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT';
const TO_PERFORMANCE = 'Withdrawal to 360 Performance Savings XXXXXX1580';

const accounts: AuditAccount[] = [
  { id: 'wf-spend', name: 'Spend', type: 'CASH', archived: false },
  { id: 'wf-sav', name: 'Savings', type: 'CASH', archived: false },
  { id: 'wf-360', name: '360 Checking', type: 'CASH', archived: false },
  { id: 'wf-perf', name: '360 Performance Savings', type: 'CASH', archived: false },
  { id: 'wf-citi', name: 'Citi Double Cash® Card', type: 'CREDIT_CARD', archived: false },
];
const mapping = { 'sfin-spend': 'wf-spend', 'sfin-sav': 'wf-sav', 'sfin-360': 'wf-360', 'sfin-perf': 'wf-perf', 'sfin-citi': 'wf-citi' };

let n = 0;
const row = (accountId: string, type: string, notes: string, group: string, date = '2026-10-01'): AuditLedgerRow => ({
  id: `r${(n += 1)}`, accountId, date, currency: 'USD', rawType: type, type, status: 'POSTED', absCents: 60000,
  group, assetId: '', external: false, phantomCash: false, notes,
});
/** Both legs of one linked transfer. */
const pair = (out: [string, string], into: [string, string], group: string, date = '2026-10-01'): AuditLedgerRow[] => [
  row(out[0], 'TRANSFER_OUT', out[1], group, date),
  row(into[0], 'TRANSFER_IN', into[1], group, date),
];
const learn = (rows: AuditLedgerRow[], overrides = emptySyncOverrides()) =>
  learnTransferNames({ ledger: { accounts, rows } as AuditLedger, mapping, overrides, now: NOW }).names;

describe('learnTransferNames — which rows teach (A1)', () => {
  it('learns both legs of a linked savings → Spend transfer, each in its own direction', () => {
    expect(learn(pair(['wf-sav', 'Withdrawal to PNC Bank XXXXXX0000 · TRN-1'], ['wf-spend', `${SAVINGS_TO_SPEND} · TRN-2`], 'g1'))).toEqual([
      { accountId: 'wf-sav', direction: 'out', signature: 'withdrawal to pnc bank' },
      { accountId: 'wf-spend', direction: 'in', signature: 'transfer capital one ach web payment' },
    ]);
  });

  it("learns 360 Checking's withdrawal to Performance Savings from one past link (R1)", () => {
    expect(learn(pair(['wf-360', `${TO_PERFORMANCE} · TRN-3`], ['wf-perf', 'Deposit from 360 Checking XXXXXX0000 · TRN-3'], 'g2'))).toContainEqual(
      { accountId: 'wf-360', direction: 'out', signature: 'withdrawal to performance savings' },
    );
  });

  it('reads the direction off the effective type', () => {
    const [leg, partner] = pair(['wf-sav', 'Withdrawal to PNC Bank XXXXXX0000 · TRN-1'], ['wf-spend', `${SAVINGS_TO_SPEND} · TRN-2`], 'g1');
    const overridden = { ...partner, rawType: 'WITHDRAWAL', type: 'TRANSFER_IN' };
    expect(learn([leg, overridden])).toContainEqual({ accountId: 'wf-spend', direction: 'in', signature: 'transfer capital one ach web payment' });
  });

  it('teaches nothing from rows that are not one leg of a link between two accounts, nor from older than a year', () => {
    expect(learn([
      row('wf-spend', 'DEPOSIT', `${SAVINGS_TO_SPEND} · TRN-4`, ''),
      row('wf-spend', 'TRANSFER_IN', `${SAVINGS_TO_SPEND} · TRN-5`, 'g-solo'),
      row('wf-spend', 'TRANSFER_OUT', 'Withdrawal to PNC Bank XXXXXX0000 · TRN-6', 'g-solo'),
      ...pair(['wf-sav', 'Withdrawal to PNC Bank XXXXXX0000 · TRN-7'], ['wf-spend', `${SAVINGS_TO_SPEND} · TRN-8`], 'g-old', '2025-10-17'),
    ])).toEqual([]);
  });

  it("never learns from the sync's own bookkeeping, a row typed by hand, or a card", () => {
    expect(learn([
      ...pair(['wf-sav', 'Starting balance · sfin-sav'], ['wf-spend', 'Balance adjustment · sfin-spend · 2026-10-01'], 'g3'),
      ...pair(['wf-sav', `${IN_TRANSIT_COMMENT_PREFIX}Withdrawal to PNC Bank XXXXXX0000 · TRN-9`], ['wf-spend', 'Moved money to checking'], 'g4'),
      ...pair(['wf-spend', '*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR · TRN-10'], ['wf-citi', 'AUTOPAY AUTO-PMT · TRN-11'], 'g5'),
    ])).toEqual([{ accountId: 'wf-spend', direction: 'out', signature: 'payment citi autopay ach web recur' }]);
  });

  it('teaches nothing from a group whose two legs carry the same note (R12), but a shared id with different wording teaches', () => {
    expect(learn(pair(['wf-sav', `${SAVINGS_TO_SPEND} · TRN-12`], ['wf-spend', `${SAVINGS_TO_SPEND} · TRN-12`], 'g6'))).toEqual([]);
    expect(learn(pair(['wf-sav', 'Withdrawal to PNC Bank XXXXXX0000 · TRN-13'], ['wf-spend', `${SAVINGS_TO_SPEND} · TRN-13`], 'g7'))).toHaveLength(2);
  });
});

describe('learnTransferNames — guards (A3)', () => {
  it('never learns a signature of only generic words', () => {
    expect(learn(pair(['wf-sav', 'ONLINE TRANSFER TO 0000 · TRN-14'], ['wf-spend', 'ACH DEBIT · TRN-15'], 'g8'))).toEqual([]);
  });

  it('one notTransfer on any row with that signature on that account blocks the name, both directions (R4)', () => {
    const undone = row('wf-spend', 'DEPOSIT', `${SAVINGS_TO_SPEND} · TRN-16`, '', '2026-10-10');
    const overrides = setTxOverride(emptySyncOverrides(), accountTxKey('sfin-spend', 'TRN-16'), 'notTransfer', NOW);
    expect(learn([...pair(['wf-sav', 'Withdrawal to PNC Bank XXXXXX0000 · TRN-1'], ['wf-spend', `${SAVINGS_TO_SPEND} · TRN-2`], 'g1'), undone], overrides)).toEqual([
      { accountId: 'wf-sav', direction: 'out', signature: 'withdrawal to pnc bank' },
    ]);
  });
});

describe('learnTransferNames — the list', () => {
  it('is newest first, one entry per name, stamped with the time it was computed', () => {
    const doc = learnTransferNames({ ledger: { accounts, rows: [
      ...pair(['wf-sav', 'Withdrawal to PNC Bank XXXXXX0000 · TRN-1'], ['wf-spend', `${SAVINGS_TO_SPEND} · TRN-2`], 'g1', '2026-09-01'),
      ...pair(['wf-360', `${TO_PERFORMANCE} · TRN-3`], ['wf-perf', 'Deposit from 360 Checking XXXXXX0000 · TRN-3'], 'g2', '2026-10-05'),
      ...pair(['wf-sav', 'Withdrawal to PNC Bank XXXXXX0000 · TRN-4'], ['wf-spend', `${SAVINGS_TO_SPEND} · TRN-5`], 'g3', '2026-10-01'),
    ] }, mapping, overrides: emptySyncOverrides(), now: NOW });
    expect(doc.computedAt).toBe('2026-10-18T15:00:00.000Z');
    expect(doc.names.map((x) => `${x.accountId} ${x.direction}`)).toEqual(['wf-360 out', 'wf-perf in', 'wf-sav out', 'wf-spend in']);
  });

  it('keeps at most 500 names', () => {
    const rows = Array.from({ length: 260 }, (_, i) => pair(
      ['wf-sav', `Withdrawal to Brokerage ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} · TRN-a${i}`],
      ['wf-spend', `Deposit from Brokerage ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} · TRN-b${i}`],
      `gx${i}`,
    )).flat();
    expect(learn(rows)).toHaveLength(500);
  });
});
