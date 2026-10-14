import { describe, it, expect } from 'vitest';
import {
  consumeVenmoMatch, isVenmoDescription, matchVenmoPayment, matchVenmoPayments, mergeVenmoRecords, pruneVenmoLedger, venmoDescription,
  venmoLedgerKey, venmoNoteOf, VENMO_LEDGER_SECRET_KEY, VENMO_MATCH_DAYS_AFTER, VENMO_MATCH_DAYS_BEFORE, VENMO_NOTE_MARK,
  type VenmoLedger, type VenmoPaymentQuery,
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
    expect(isVenmoDescription('SVENMOX')).toBe(false);
    expect(isVenmoDescription('VENMO1023')).toBe(true);
    expect(matchVenmoPayment(one, query({ description: 'ZELLE TO JANE DOE' }))).toBeNull();
  });

  it('gives no note when the direction does not match — a deposit is not a payment you made', () => {
    expect(matchVenmoPayment(one, query({ direction: 'in' }))).toBeNull();
  });

  it('needs the exact amount', () => {
    expect(matchVenmoPayment(one, query({ amountCents: 2501 }))).toBeNull();
  });

  it('allows a bank row from 1 calendar day before the email day to 5 after, at any time of day, and not a day more', () => {
    const at2 = (iso: string, hh: string) => Date.parse(`${iso}T${hh}Z`);
    expect(VENMO_MATCH_DAYS_BEFORE).toBe(1);
    expect(VENMO_MATCH_DAYS_AFTER).toBe(5);
    expect(matchVenmoPayment(one, query({ postedMs: at2('2026-10-08', '23:59:59') }))).not.toBeNull();
    expect(matchVenmoPayment(one, query({ postedMs: at2('2026-10-02', '00:00:00') }))).not.toBeNull();
    expect(matchVenmoPayment(one, query({ postedMs: at2('2026-10-09', '00:00:00') }))).toBeNull();
    expect(matchVenmoPayment(one, query({ postedMs: at2('2026-10-01', '23:59:59') }))).toBeNull();
    // The old ±5 days: a bank row never comes days before the payment's email.
    expect(matchVenmoPayment(one, query({ postedMs: at2('2026-09-28', '23:00:00') }))).toBeNull();
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

describe('review fixes', () => {
  it('re-running the row that consumed a payment still finds it after another same-amount payment arrives', () => {
    const l = ledgerOf({ ...RENT, emailDate: '2026-10-03', consumedBy: 'sfin-1\u0000tx-v' },
      { ...RENT, counterparty: 'Bob', note: 'Cable', emailDate: '2026-10-05' });
    expect(matchVenmoPayment(l, query())).toEqual({ key: 'k0', note: 'Rent October', counterparty: 'Jane Doe' });
  });

  it('prunes a record whose email date cannot be read', () => {
    const out = pruneVenmoLedger(ledgerOf({ ...RENT, emailDate: 'garbage' }), at('2026-10-14'));
    expect(out.removed).toBe(1);
    expect(out.ledger).toEqual({});
  });

  it('gives no note when two records differ by payment id', () => {
    const l = ledgerOf({ ...RENT, paymentId: '1', emailDate: '2026-10-03' }, { ...RENT, paymentId: '2', emailDate: '2026-10-03' });
    expect(matchVenmoPayment(l, query())).toBeNull();
  });

  it('gives no note for a money-in bank row against an out record (a refund shape)', () => {
    expect(matchVenmoPayment(ledgerOf({ ...RENT, emailDate: '2026-10-03' }), query({ direction: 'in' }))).toBeNull();
  });
});

describe('matchVenmoPayments — one payment, one row, per sync run (ruling P3-K)', () => {
  // The final review's case: Sam's $20 email on Oct 14; two $20 VENMO rows, Oct 10
  // (a payment whose email never came — mail before the filter existed) and Oct 15.
  const COFFEE: VenmoRecord = { direction: 'out', kind: 'payment', amountCents: 2000, counterparty: 'Sam', note: 'Coffee club' };
  const sam = ledgerOf({ ...COFFEE, emailDate: '2026-10-14' });
  const row = (id: string, day: string, over: Partial<VenmoPaymentQuery> = {}): VenmoPaymentQuery =>
    query({ description: `VENMO PAYMENT ${id}`, amountCents: 2000, postedMs: at(day), txKey: `sfin-1\u0000${id}`, ...over });
  const OLD = row('tx-old', '2026-10-10');
  const NEW = row('tx-new', '2026-10-15');
  const noted = (m: Map<string, { note: string }>) => Object.fromEntries([...m].map(([k, v]) => [k.split('\u0000')[1], v.note]));

  it('gives the record to the Oct 15 row and none to the Oct 10 row, in either feed order', () => {
    expect(noted(matchVenmoPayments(sam, [OLD, NEW]))).toEqual({ 'tx-new': 'Coffee club' });
    expect(noted(matchVenmoPayments(sam, [NEW, OLD]))).toEqual({ 'tx-new': 'Coffee club' });
  });

  it('gives neither row a note when both fall inside the window', () => {
    const both = [row('tx-a', '2026-10-14'), row('tx-b', '2026-10-16')];
    expect(noted(matchVenmoPayments(sam, both))).toEqual({});
    expect(noted(matchVenmoPayments(sam, [...both].reverse()))).toEqual({});
  });

  it('counts a pending VENMO row as a blocker: the posted row gets nothing, the pending one never does', () => {
    const pending = row('tx-p', '2026-10-16', { pending: true });
    expect(noted(matchVenmoPayments(sam, [NEW, pending]))).toEqual({});
    expect(noted(matchVenmoPayments(sam, [pending]))).toEqual({});
  });

  it('keeps a row’s own consumed record on a re-run, whatever other row now wants it', () => {
    const consumed = ledgerOf({ ...COFFEE, emailDate: '2026-10-14', consumedBy: NEW.txKey });
    expect(noted(matchVenmoPayments(consumed, [row('tx-other', '2026-10-16'), NEW]))).toEqual({ 'tx-new': 'Coffee club' });
    expect(noted(matchVenmoPayments(consumed, [NEW, row('tx-other', '2026-10-16')]))).toEqual({ 'tx-new': 'Coffee club' });
  });

  it('measures the window from a day before the email to five after: −1 in, −2 out, +5 in, +6 out', () => {
    expect(noted(matchVenmoPayments(sam, [row('tx-m1', '2026-10-13')]))).toEqual({ 'tx-m1': 'Coffee club' });
    expect(noted(matchVenmoPayments(sam, [row('tx-m2', '2026-10-12')]))).toEqual({});
    expect(noted(matchVenmoPayments(sam, [row('tx-p5', '2026-10-19')]))).toEqual({ 'tx-p5': 'Coffee club' });
    expect(noted(matchVenmoPayments(sam, [row('tx-p6', '2026-10-20')]))).toEqual({});
  });

  it('drops a contested record for every row that wanted it — and its identical twin with it', () => {
    // A bank transfer's two emails (initiated Oct 3, arrived Oct 5) are one payment:
    // a row that saw both and a row that saw only the second compete for it.
    const BANK: VenmoRecord = { direction: 'in', kind: 'bank-transfer', amountCents: 10000, counterparty: null, note: 'Transfer to your bank' };
    const twins = ledgerOf({ ...BANK, emailDate: '2026-10-03' }, { ...BANK, emailDate: '2026-10-05' });
    const bank = (id: string, day: string) => row(id, day, { description: 'VENMO CASHOUT', amountCents: 10000, direction: 'in' });
    expect(noted(matchVenmoPayments(twins, [bank('tx-1', '2026-10-04'), bank('tx-2', '2026-10-09')]))).toEqual({});
    // Alone, the first row still gets the transfer's note once.
    expect(noted(matchVenmoPayments(twins, [bank('tx-1', '2026-10-04')]))).toEqual({ 'tx-1': 'Transfer to your bank' });
  });

  it('a row that could be two payments gets none, even once the other row contests one of them — nor does that row (P3-L)', () => {
    const two = ledgerOf({ ...COFFEE, emailDate: '2026-10-14' }, { ...COFFEE, counterparty: 'Ann', note: 'Lunch', emailDate: '2026-10-17' });
    // tx-a can be either payment; tx-b only Sam's (Oct 13 is before Ann's window).
    // Ann's email may belong to a payment with no bank row, so tx-a is not known to be Ann's.
    expect(noted(matchVenmoPayments(two, [row('tx-a', '2026-10-17'), row('tx-b', '2026-10-13')]))).toEqual({});
    expect(noted(matchVenmoPayments(two, [row('tx-b', '2026-10-13'), row('tx-a', '2026-10-17')]))).toEqual({});
  });

  it('a row with exactly one candidate that no other row wants still gets it beside an ambiguous row (P3-L)', () => {
    const three = ledgerOf(
      { ...COFFEE, emailDate: '2026-10-14' },
      { ...COFFEE, counterparty: 'Ann', note: 'Lunch', emailDate: '2026-10-17' },
      { ...COFFEE, counterparty: 'Bob', note: 'Tickets', emailDate: '2026-10-25' },
    );
    // tx-a: Sam or Ann (ambiguous); tx-c: only Bob's, and nobody else wants Bob's.
    expect(noted(matchVenmoPayments(three, [row('tx-a', '2026-10-17'), row('tx-c', '2026-10-25')]))).toEqual({ 'tx-c': 'Tickets' });
  });
});
