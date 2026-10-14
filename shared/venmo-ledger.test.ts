import { describe, it, expect } from 'vitest';
import {
  consumeVenmoMatch, isVenmoDescription, matchVenmoPayment, mergeVenmoRecords, pruneVenmoLedger, venmoDescription,
  venmoLedgerKey, venmoNoteOf, VENMO_LEDGER_SECRET_KEY, VENMO_NOTE_MARK, type VenmoLedger, type VenmoPaymentQuery,
} from './venmo-ledger';
import type { VenmoRecord } from './venmo';

const RENT: VenmoRecord = { direction: 'out', kind: 'payment', amountCents: 2500, counterparty: 'Jane Doe', note: 'Rent October' };
const at = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
const ledgerOf = (...recs: Array<VenmoRecord & { emailDate: string; consumedBy?: string }>): VenmoLedger =>
  Object.fromEntries(recs.map((r, i) => [`k${i}`, r]));
const query = (over: Partial<VenmoPaymentQuery> = {}): VenmoPaymentQuery => ({
  description: 'VENMO PAYMENT 1023', amountCents: 2500, direction: 'out', postedMs: at('2026-10-04'), txKey: 'sfin-1\u0000tx-v', ...over,
});

describe('matchVenmoPayment', () => {
  const one = ledgerOf({ ...RENT, emailDate: '2026-10-03' });

  it('matches the one payment with the same amount and direction within 5 days', () => {
    expect(matchVenmoPayment(one, query())).toEqual({ key: 'k0', note: 'Rent October', counterparty: 'Jane Doe' });
  });

  it('needs the word VENMO in the bank text, any case', () => {
    expect(isVenmoDescription('PAYPAL *VENMO 4029357733')).toBe(true);
    expect(isVenmoDescription('Venmo cashout')).toBe(true);
    expect(isVenmoDescription('VENMOX STORE')).toBe(false);
    expect(matchVenmoPayment(one, query({ description: 'ZELLE TO JANE DOE' }))).toBeNull();
  });

  it('gives no note when the direction does not match — a deposit is not a payment you made', () => {
    expect(matchVenmoPayment(one, query({ direction: 'in' }))).toBeNull();
  });

  it('needs the exact amount', () => {
    expect(matchVenmoPayment(one, query({ amountCents: 2501 }))).toBeNull();
  });

  it('allows 5 days either side of the email and not a moment more', () => {
    const email = Date.parse('2026-10-03');
    expect(matchVenmoPayment(one, query({ postedMs: email + 5 * 86_400_000 }))).not.toBeNull();
    expect(matchVenmoPayment(one, query({ postedMs: email - 5 * 86_400_000 }))).not.toBeNull();
    expect(matchVenmoPayment(one, query({ postedMs: email + 5 * 86_400_000 + 1 }))).toBeNull();
  });

  it('gives no note when two payments of the same amount fall in the window', () => {
    const two = ledgerOf({ ...RENT, emailDate: '2026-10-03' }, { ...RENT, note: 'Cable', emailDate: '2026-10-05' });
    expect(matchVenmoPayment(two, query())).toBeNull();
  });

  it('never offers a payment another row consumed; offers one this row consumed again', () => {
    expect(matchVenmoPayment(ledgerOf({ ...RENT, emailDate: '2026-10-03', consumedBy: 'sfin-1\u0000tx-other' }), query())).toBeNull();
    expect(matchVenmoPayment(ledgerOf({ ...RENT, emailDate: '2026-10-03', consumedBy: 'sfin-1\u0000tx-v' }), query())).not.toBeNull();
  });

  it('skips a record whose email date cannot be read', () => {
    expect(matchVenmoPayment(ledgerOf({ ...RENT, emailDate: 'not a date' }), query())).toBeNull();
  });
});

describe('the ledger', () => {
  it('lives in the venmo_ledger secret', () => {
    expect(VENMO_LEDGER_SECRET_KEY).toBe('venmo_ledger');
  });

  it('keys by Venmo’s payment id when there is one, else by every field and the day', () => {
    expect(venmoLedgerKey({ ...RENT, paymentId: '41234567' }, '2026-10-03')).toBe('id|41234567');
    expect(venmoLedgerKey(RENT, '2026-10-03')).toBe('out|2500|Jane Doe|Rent October|2026-10-03');
  });

  it('merges idempotently and never revives a consumed record', () => {
    const first = mergeVenmoRecords({}, [RENT], '2026-10-03');
    expect(first.added).toBe(1);
    const key = venmoLedgerKey(RENT, '2026-10-03');
    const consumed = consumeVenmoMatch(first.ledger, { key, note: 'Rent October', counterparty: 'Jane Doe' }, 'sfin-1\u0000tx-v');
    const again = mergeVenmoRecords(consumed, [RENT], '2026-10-03');
    expect(again.added).toBe(0);
    expect(again.ledger[key].consumedBy).toBe('sfin-1\u0000tx-v');
  });

  it('prunes records older than 90 days', () => {
    const ledger = ledgerOf({ ...RENT, emailDate: '2026-07-01' }, { ...RENT, note: 'Cable', emailDate: '2026-10-01' });
    const out = pruneVenmoLedger(ledger, at('2026-10-14'));
    expect(out.removed).toBe(1);
    expect(Object.values(out.ledger).map((r) => r.note)).toEqual(['Cable']);
  });

  it('consuming a key that is gone changes nothing', () => {
    const ledger = ledgerOf({ ...RENT, emailDate: '2026-10-03' });
    expect(consumeVenmoMatch(ledger, { key: 'missing', note: '', counterparty: null }, 'x')).toBe(ledger);
  });
});

describe('the note on the bank row', () => {
  it('appends " · Venmo: <note>" to the bank’s own words and reads it back', () => {
    expect(VENMO_NOTE_MARK).toBe(' · Venmo: ');
    expect(venmoDescription('VENMO PAYMENT 1023', 'Rent October')).toBe('VENMO PAYMENT 1023 · Venmo: Rent October');
    expect(venmoDescription('VENMO PAYMENT 1023', '')).toBe('VENMO PAYMENT 1023');
    expect(venmoNoteOf('VENMO PAYMENT 1023', 'VENMO PAYMENT 1023 · Venmo: Rent · split')).toBe('Rent · split');
  });
});

describe('a bank transfer that sends two emails (initiated, arrived)', () => {
  const BANK: VenmoRecord = { direction: 'in', kind: 'bank-transfer', amountCents: 10000, counterparty: null, note: 'Transfer to your bank' };
  const bq = (over: Partial<VenmoPaymentQuery> = {}) => query({ description: 'VENMO CASHOUT', amountCents: 10000, direction: 'in', postedMs: at('2026-10-06'), ...over });

  it('is one record when both emails arrive the same day', () => {
    const once = mergeVenmoRecords({}, [BANK, BANK], '2026-10-04');
    expect(once.added).toBe(1);
    expect(Object.keys(once.ledger)).toHaveLength(1);
  });

  it('still matches when the two emails are on different days — identical records are one transfer', () => {
    let l = mergeVenmoRecords({}, [BANK], '2026-10-03').ledger;
    l = mergeVenmoRecords(l, [BANK], '2026-10-05').ledger;
    expect(matchVenmoPayment(l, bq())).toEqual({ key: 'in|10000||Transfer to your bank|2026-10-03', note: 'Transfer to your bank', counterparty: null });
  });

  it('does not merge two genuine same-amount transfers: both stay in the ledger, each consumed by its own row', () => {
    let l = mergeVenmoRecords({}, [BANK], '2026-10-03').ledger;
    l = mergeVenmoRecords(l, [BANK], '2026-10-10').ledger;
    expect(Object.keys(l)).toHaveLength(2);
    const first = matchVenmoPayment(l, bq({ postedMs: at('2026-10-04'), txKey: 'a' }))!;
    expect(first.key).toContain('2026-10-03');
    l = consumeVenmoMatch(l, first, 'a');
    const second = matchVenmoPayment(l, bq({ postedMs: at('2026-10-11'), txKey: 'b' }))!;
    expect(second.key).toContain('2026-10-10');
  });

  it('still gives no note when the candidates differ in their note', () => {
    const l = ledgerOf({ ...BANK, note: 'A', emailDate: '2026-10-03' }, { ...BANK, note: 'B', emailDate: '2026-10-05' });
    expect(matchVenmoPayment(l, bq())).toBeNull();
  });
});
