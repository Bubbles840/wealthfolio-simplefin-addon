import { describe, it, expect } from 'vitest';
import { explainBalance } from './audit-balance';
import { healthIssues } from './audit-health';
import type { AuditLedgerRow } from './audit-ledger';

/** A card's bookkeeping rows, as the 3.10 rewrite leaves them: TRANSFER_OUT, unlinked, marked external. */
const row = (id: string, notes: string, absCents: number, date = '2026-04-20'): AuditLedgerRow => ({
  id, accountId: 'wf-c', date, currency: 'USD', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', status: 'POSTED', absCents,
  group: '', assetId: '', external: true, phantomCash: false, notes,
});
const ROWS = [
  row('open', 'Starting balance · sfc', 46460, '2026-04-19'),
  row('plug', 'Balance adjustment · sfc · 2026-09-02', 1250, '2026-09-02'),
  row('held', '↔️ In-transit transfer · BALANCE TRANSFER · tx-bt', 25000, '2026-10-12'),
];
const ledger = { accounts: [{ id: 'wf-c', name: 'Citi Card', type: 'CREDIT_CARD', archived: false }], rows: ROWS };

describe('the audit still knows a card\'s bookkeeping by its note once it is a TRANSFER_OUT', () => {
  it('never calls one an incomplete transfer', () => {
    const issues = healthIssues({ ledger, mapping: { sfc: 'wf-c' } }).issues ?? [];
    expect(issues.filter((i) => i.kind === 'incomplete-leg')).toEqual([]);
  });

  it('books each as money owed, and names the starting balance and the correction in the balance', () => {
    const e = explainBalance({
      mapping: { sfc: 'wf-c' }, balances: { sfc: { balance: -727.1, date: Date.parse('2026-10-14T12:00:00Z') / 1000 } }, ledger,
    }, 'wf-c')!;
    expect(e.wealthfolioCents).toBe(-72710);
    expect(e.offCents).toBe(0);
    expect(e.includes).toEqual({ start: { cents: -46460, date: '2026-04-19' }, corrections: { count: 1, cents: -1250, latest: '2026-09-02' } });
  });
});
