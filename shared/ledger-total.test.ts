import { describe, it, expect } from 'vitest';
import { cashEffectCents, typeCashSign } from './audit-ledger.js';
import { postedLedgerTotal } from './ledger-total.js';
import { IN_TRANSIT_COMMENT_PREFIX, PENDING_SUFFIX } from './sync-core.js';

describe('typeCashSign — the one sign table (R14)', () => {
  it('signs money in, money out and the types that move no cash', () => {
    for (const t of ['DEPOSIT', 'CREDIT', 'TRANSFER_IN', 'DIVIDEND', 'INTEREST', 'SELL']) expect(typeCashSign(t, 'CASH')).toBe(1);
    for (const t of ['WITHDRAWAL', 'TRANSFER_OUT', 'FEE', 'TAX', 'BUY']) expect(typeCashSign(t, 'CASH')).toBe(-1);
    for (const t of ['SPLIT', 'ADJUSTMENT', 'UNKNOWN', '']) expect(typeCashSign(t, 'CASH')).toBe(0);
  });

  it('reads card interest as a charge, and is case-blind', () => {
    expect(typeCashSign('INTEREST', 'CREDIT_CARD')).toBe(-1);
    expect(typeCashSign('interest', 'credit_card')).toBe(-1);
    expect(typeCashSign('withdrawal', 'CREDIT_CARD')).toBe(-1);
  });

  it('leaves the audits\' raw-type figure exactly as it was', () => {
    expect(cashEffectCents({ rawType: 'WITHDRAWAL', absCents: 4240 }, 'CASH')).toBe(-4240);
    expect(cashEffectCents({ rawType: 'INTEREST', absCents: 100 }, 'CREDIT_CARD')).toBe(-100);
    expect(cashEffectCents({ rawType: 'SPLIT', absCents: 100 }, 'CASH')).toBe(0);
  });
});

describe('postedLedgerTotal — a card total the app can compute (B1)', () => {
  it('adds the effective types up in dollars, pending rows left out', () => {
    expect(postedLedgerTotal([
      { activityType: 'WITHDRAWAL', amount: '100', comment: 'COFFEE · t1' },
      { activityType: 'WITHDRAWAL', amount: 30, comment: 'LUNCH · t2' },
      { activityType: 'TRANSFER_IN', amount: '50', comment: 'PAYMENT · t3' },
      { activityType: 'CREDIT', amount: '5', comment: 'REFUND · t4' },
      { activityType: 'WITHDRAWAL', amount: '40', comment: `NOT YET · t5${PENDING_SUFFIX}` },
      { activityType: 'INTEREST', amount: '1.25', comment: 'INTEREST CHARGE · t6' },
    ], 'CREDIT_CARD')).toBe(-76.25);
  });

  it('has no figure for an account holding an in-transit placeholder', () => {
    expect(postedLedgerTotal([
      { activityType: 'WITHDRAWAL', amount: '100', comment: 'COFFEE · t1' },
      { activityType: 'TRANSFER_IN', amount: '42.40', comment: `${IN_TRANSIT_COMMENT_PREFIX}PAYMENT · t2` },
    ], 'CREDIT_CARD')).toBeNull();
  });

  it('is zero for no rows, and skips an amount that is not a number', () => {
    expect(postedLedgerTotal([], 'CREDIT_CARD')).toBe(0);
    expect(postedLedgerTotal([{ activityType: 'WITHDRAWAL', amount: 'n/a', comment: null }], 'CREDIT_CARD')).toBe(0);
  });
});
