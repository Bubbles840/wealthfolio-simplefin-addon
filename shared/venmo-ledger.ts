/**
 * shared/venmo-ledger.ts
 *
 * Remembering parsed Venmo payments, and deciding which bank row each one is —
 * the `amazon-ledger.ts` pattern (merge by key, prune at 90 days, consume by
 * `accountTxKey`), with Venmo's own match: the word VENMO in the bank text, the
 * exact amount, the same direction, ±5 days of the email, and exactly one
 * distinct record (identical duplicate emails count as one). Host-agnostic; the ledger is an add-on secret both syncers read and
 * the companion's mail poll writes.
 */
import type { VenmoDirection, VenmoRecord } from './venmo.js';

export interface VenmoLedgerRecord extends VenmoRecord {
  /** The EMAIL's date (YYYY-MM-DD), the anchor the ±window is measured from. */
  emailDate: string;
  /** The `accountTxKey` this payment was matched to — consumed, never deleted,
   *  so a re-read email cannot offer it to a second row. */
  consumedBy?: string;
}

export type VenmoLedger = Record<string, VenmoLedgerRecord>;

/** Written by the companion (it reads the mailbox), read by both syncers. */
export const VENMO_LEDGER_SECRET_KEY = 'venmo_ledger';
export const VENMO_MATCH_WINDOW_DAYS = 5;
export const VENMO_LEDGER_RETENTION_DAYS = 90;
/** What goes between the bank's text and the note: `VENMO PAYMENT 1023 · Venmo: Rent October`. */
export const VENMO_NOTE_MARK = ' · Venmo: ';

const DAY_MS = 86_400_000;

/** Whether a bank description is a Venmo row: the word VENMO, any case. */
export function isVenmoDescription(description: string | null | undefined): boolean {
  return /\bvenmo(?=\d|\b)/i.test(description ?? '');
}

/** Ledger key: Venmo's payment id when the email had one; otherwise every field
 *  and the email's day, so re-reading the same message adds nothing. */
export function venmoLedgerKey(r: VenmoRecord, emailDate: string): string {
  return r.paymentId
    ? `id|${r.paymentId}`
    : `${r.direction}|${r.amountCents}|${r.counterparty ?? ''}|${r.note}|${emailDate}`;
}

/** Fold newly parsed payments in. Idempotent: a known key is left exactly as it
 *  is, so a consumed record is never revived as a fresh candidate. */
export function mergeVenmoRecords(
  ledger: VenmoLedger,
  records: readonly VenmoRecord[],
  emailDate: string,
): { ledger: VenmoLedger; added: number } {
  const next: VenmoLedger = { ...ledger };
  let added = 0;
  for (const r of records) {
    const key = venmoLedgerKey(r, emailDate);
    if (next[key]) continue;
    next[key] = { ...r, emailDate };
    added += 1;
  }
  return { ledger: next, added };
}

/** Drop records older than the retention window, matched or not. */
export function pruneVenmoLedger(
  ledger: VenmoLedger,
  nowMs: number,
  days = VENMO_LEDGER_RETENTION_DAYS,
): { ledger: VenmoLedger; removed: number } {
  const cutoff = nowMs - days * DAY_MS;
  const next: VenmoLedger = {};
  let removed = 0;
  for (const [key, rec] of Object.entries(ledger)) {
    const t = Date.parse(rec.emailDate);
    if (!Number.isFinite(t) || t < cutoff) { removed += 1; continue; }
    next[key] = rec;
  }
  return { ledger: next, removed };
}

export interface VenmoPaymentQuery {
  /** The bank's own description. */
  description: string;
  /** Magnitude in cents. */
  amountCents: number;
  /** Which way the bank row moved money: `out` for a negative SimpleFin amount. */
  direction: VenmoDirection;
  /** When the row posted, epoch ms. */
  postedMs: number;
  /** `accountTxKey(sfAccountId, txId)`. */
  txKey: string;
}

export interface VenmoMatch {
  /** The ledger key, consumed by `consumeVenmoMatch`. */
  key: string;
  note: string;
  counterparty: string | null;
}

/**
 * The Venmo payment a bank row is, or null. Two candidates — two $25.00
 * payments the same week — is null: a wrong note on real money is invisible,
 * a missing one is merely a row without a note. A record consumed by another
 * row is not a candidate; one consumed by THIS row is, so a re-run is
 * idempotent.
 */
export function matchVenmoPayment(
  ledger: VenmoLedger,
  query: VenmoPaymentQuery,
  windowDays = VENMO_MATCH_WINDOW_DAYS,
): VenmoMatch | null {
  if (!isVenmoDescription(query.description)) return null;
  const postedDay = Math.floor(query.postedMs / DAY_MS);
  const hits: Array<[string, VenmoLedgerRecord]> = [];
  for (const [key, rec] of Object.entries(ledger)) {
    if (rec.amountCents !== query.amountCents || rec.direction !== query.direction) continue;
    if (rec.consumedBy && rec.consumedBy !== query.txKey) continue;
    const emailMs = Date.parse(rec.emailDate);
    if (!Number.isFinite(emailMs) || Math.abs(postedDay - Math.floor(emailMs / DAY_MS)) > windowDays) continue;
    hits.push([key, rec]);
  }
  if (hits.length === 0) return null;
  // Idempotent: a payment this very row already consumed is its answer, whatever else arrived since.
  const own = hits.find(([, r]) => r.consumedBy === query.txKey);
  if (own) return { key: own[0], note: own[1].note, counterparty: own[1].counterparty };
  // A bank transfer sends two emails (initiated, arrived) that parse to the same
  // record, possibly on different days. Candidates identical in every field are
  // one payment, and they would give the same note anyway, so they are not
  // ambiguous. A payment this row already consumed wins, else the earliest.
  const sig = (r: VenmoLedgerRecord) => JSON.stringify([r.kind, r.counterparty, r.note, r.paymentId ?? null]);
  if (hits.some(([, r]) => sig(r) !== sig(hits[0][1]))) return null;
  hits.sort((a, b) => Number(b[1].consumedBy === query.txKey) - Number(a[1].consumedBy === query.txKey)
    || a[1].emailDate.localeCompare(b[1].emailDate));
  const [key, rec] = hits[0];
  return { key, note: rec.note, counterparty: rec.counterparty };
}

/** Record that a payment's bank row was found. */
export function consumeVenmoMatch(ledger: VenmoLedger, match: VenmoMatch, txKey: string): VenmoLedger {
  return ledger[match.key] ? { ...ledger, [match.key]: { ...ledger[match.key], consumedBy: txKey } } : ledger;
}

/** The description to store: the bank's text, then ` · Venmo: <note>`.
 *  APPENDED, never substituted — the bank's words are what every mapping rule
 *  and the person recognise; Wealthfolio's category rules read the note too. */
export function venmoDescription(description: string, note: string): string {
  return note ? `${description}${VENMO_NOTE_MARK}${note}` : description;
}

/** The note `venmoDescription` added: the text after ` · Venmo: `. */
export function venmoNoteOf(bare: string, enriched: string): string {
  const head = `${bare}${VENMO_NOTE_MARK}`;
  return enriched.startsWith(head) ? enriched.slice(head.length) : enriched;
}
