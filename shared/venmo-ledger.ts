/**
 * shared/venmo-ledger.ts
 *
 * Remembering parsed Venmo payments, and deciding which bank row each one is —
 * the `amazon-ledger.ts` pattern (merge by key, prune at 90 days, consume by
 * `accountTxKey`), with Venmo's own match: the word VENMO in the bank text, the
 * exact amount, the same direction, a bank row dated from the day before the
 * email to five days after it, and one payment for one row — a payment two
 * rows of the run could be is nobody's, and a row two payments could be gets
 * none, whatever happens to the other payment (identical duplicate emails
 * count as one). Host-agnostic; the ledger is an add-on secret both syncers
 * read and the companion's mail poll writes.
 */
import type { VenmoDirection, VenmoRecord } from './venmo.js';

export interface VenmoLedgerRecord extends VenmoRecord {
  /** The EMAIL's date (YYYY-MM-DD), the anchor the match window is measured from. */
  emailDate: string;
  /** The `accountTxKey` this payment was matched to — consumed, never deleted,
   *  so a re-read email cannot offer it to a second row. */
  consumedBy?: string;
}

export type VenmoLedger = Record<string, VenmoLedgerRecord>;

/** Written by the companion (it reads the mailbox), read by both syncers. */
export const VENMO_LEDGER_SECRET_KEY = 'venmo_ledger';
/** A bank row posts at most this many calendar days BEFORE its email's day —
 *  never really before it; the one day absorbs the email's UTC day (ruling P3-K). */
export const VENMO_MATCH_DAYS_BEFORE = 1;
/** …and at most this many calendar days after it. */
export const VENMO_MATCH_DAYS_AFTER = 5;
export const VENMO_LEDGER_RETENTION_DAYS = 90;
/** What goes between the bank's text and the note: `VENMO PAYMENT 1023 · Venmo: Rent October`. */
export const VENMO_NOTE_MARK = ' · Venmo: ';

const DAY_MS = 86_400_000;

/**
 * Whether every entry of a ledger read from a secret has the fields the matcher
 * touches. A null or non-object entry would throw inside `matchVenmoPayments`, so
 * a sync checks first: a ledger that fails is treated as unreadable — Venmo
 * notes are skipped for the run and the ledger is never written back over it.
 */
export function isReadableVenmoLedger(ledger: unknown): ledger is VenmoLedger {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return false;
  return Object.values(ledger).every((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
    const e = r as Record<string, unknown>;
    return (e.direction === 'in' || e.direction === 'out')
      && typeof e.amountCents === 'number' && Number.isFinite(e.amountCents)
      && typeof e.note === 'string' && typeof e.emailDate === 'string'
      && (e.consumedBy === undefined || typeof e.consumedBy === 'string');
  });
}

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
  /** A pending row: it competes for a payment — one it could be is nobody's this
   *  run — but is never matched itself (notes go on posted rows only, P3-G). */
  pending?: boolean;
}

export interface VenmoMatch {
  /** The ledger key, consumed by `consumeVenmoMatch`. */
  key: string;
  note: string;
  counterparty: string | null;
}

type Hit = [string, VenmoLedgerRecord];

/** The records a row could be: its amount and direction, its window by calendar
 *  day (a day before the email to five after), and not consumed by another row. */
function venmoCandidates(ledger: VenmoLedger, query: VenmoPaymentQuery): Hit[] {
  if (!isVenmoDescription(query.description)) return [];
  const postedDay = Math.floor(query.postedMs / DAY_MS);
  const hits: Hit[] = [];
  for (const [key, rec] of Object.entries(ledger)) {
    if (rec.amountCents !== query.amountCents || rec.direction !== query.direction) continue;
    if (rec.consumedBy && rec.consumedBy !== query.txKey) continue;
    const emailMs = Date.parse(rec.emailDate);
    if (!Number.isFinite(emailMs)) continue;
    const emailDay = Math.floor(emailMs / DAY_MS);
    if (postedDay < emailDay - VENMO_MATCH_DAYS_BEFORE || postedDay > emailDay + VENMO_MATCH_DAYS_AFTER) continue;
    hits.push([key, rec]);
  }
  return hits;
}

/** A bank transfer sends two emails (initiated, arrived) that parse to the same
 *  record, possibly on different days. Records identical in every field are one
 *  payment, and would give the same note anyway. */
const paymentSig = (r: VenmoLedgerRecord) => JSON.stringify([r.kind, r.counterparty, r.note, r.paymentId ?? null]);

const toMatch = ([key, rec]: Hit): VenmoMatch => ({ key, note: rec.note, counterparty: rec.counterparty });

/**
 * Which Venmo payment each bank row of one sync run is — one payment to one row
 * (ruling P3-K). Every row of the run is asked together, so the answer never
 * depends on the order the feed lists them in:
 *  - a row that already consumed a payment keeps it, whatever arrived since
 *    (idempotent re-runs, P3-E), and competes for nothing else;
 *  - otherwise a row gets a payment only when it could be EXACTLY ONE payment
 *    from the start (identical twins are one), and no other row of the run —
 *    a pending row included — could be that payment too (ruling P3-L).
 * A row that could be two payments stays without a note even when another row
 * contests one of them: the other email may be a payment with no bank row, so
 * it is not known to be this row's. A wrong note on real money is invisible;
 * a missing one is merely a row without a note. Pending rows are never in the
 * answer.
 */
export function matchVenmoPayments(ledger: VenmoLedger, queries: readonly VenmoPaymentQuery[]): Map<string, VenmoMatch> {
  const matches = new Map<string, VenmoMatch>();
  const open: Array<{ txKey: string; hits: Hit[] }> = [];
  const wantedBy = new Map<string, number>();
  for (const q of queries) {
    const hits = venmoCandidates(ledger, q);
    if (hits.length === 0) continue;
    const own = q.pending ? undefined : hits.find(([, r]) => r.consumedBy === q.txKey);
    if (own) {
      matches.set(q.txKey, toMatch(own));
      continue;
    }
    for (const [key] of hits) wantedBy.set(key, (wantedBy.get(key) ?? 0) + 1);
    if (!q.pending) open.push({ txKey: q.txKey, hits });
  }
  for (const { txKey, hits } of open) {
    // Ambiguous from the start: two payments it could be.
    if (hits.some(([, r]) => paymentSig(r) !== paymentSig(hits[0][1]))) continue;
    // Contested: another row could be this payment (any of its emails).
    if (hits.some(([key]) => (wantedBy.get(key) ?? 0) > 1)) continue;
    // One payment, possibly in two emails: the earliest stands for it.
    const sorted = [...hits].sort((a, b) => a[1].emailDate.localeCompare(b[1].emailDate));
    matches.set(txKey, toMatch(sorted[0]));
  }
  return matches;
}

/** One row on its own: `matchVenmoPayments` with nothing to compete against. */
export function matchVenmoPayment(ledger: VenmoLedger, query: VenmoPaymentQuery): VenmoMatch | null {
  return matchVenmoPayments(ledger, [query]).get(query.txKey) ?? null;
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
