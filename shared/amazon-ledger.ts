/**
 * shared/amazon-ledger.ts
 *
 * Remembering parsed Amazon orders, and deciding which bank charge each one is.
 *
 * Separate from the parsing in `./amazon.js` because the two fail differently and
 * are read by different hosts: the companion parses mail, both hosts read the
 * ledger. Host-agnostic — persistence is the caller's (an addon secret).
 */

import type { AmazonOrderRecord } from './amazon.js';

/** A parsed order, plus what has happened to it since. */
export interface AmazonLedgerRecord extends AmazonOrderRecord {
  /** ISO date of the EMAIL, which is the anchor the ±window is measured from. */
  emailDate: string;
  /**
   * The `accountTxKey` this order was applied to, once one matched.
   *
   * Records are consumed rather than deleted so re-parsing the same message is
   * idempotent and so a later sync recognises the charge it already enriched
   * instead of treating it as a second candidate.
   */
  consumedBy?: string;
}

/** The ledger as it is stored: keyed for idempotence, not ordered. */
export type AmazonLedger = Record<string, AmazonLedgerRecord>;

/**
 * The secret both syncers read the ledger from.
 *
 * Named here rather than in each host's key map because the companion WRITES it
 * (it reads the mailbox) and the addon READS it — a typo in either would look like
 * "Amazon categorization silently does nothing", the hardest kind of bug to notice.
 */
export const AMAZON_LEDGER_SECRET_KEY = 'amazon_order_ledger';

/**
 * Amazon's card descriptors. Deliberately narrow.
 *
 * A false positive here does no damage on its own — a non-Amazon charge simply
 * finds no ledger record — but it widens the amount-collision surface for nothing,
 * so only Amazon's actual retail descriptors are listed. `AMAZON WEB SERVICES` and
 * `Amazon Prime` are absent on purpose: neither produces an order email, so
 * matching them could only ever be wrong.
 */
const AMAZON_DESCRIPTOR = /\b(?:amazon|amzn)\b/i;

const AWS_OR_SUBSCRIPTION = /web\s*services|\baws\b|prime\s*video|amazon\s*prime|kindle\s*unltd/i;

/** Whether a bank description looks like an Amazon retail purchase. */
export function isAmazonDescription(description: string | null | undefined): boolean {
  const d = description ?? '';
  if (AWS_OR_SUBSCRIPTION.test(d)) return false;
  return AMAZON_DESCRIPTOR.test(d);
}

/**
 * Ledger key.
 *
 * Includes `kind` so a confirmation and its later shipment notice both persist —
 * they can disagree on the total (a split shipment charges per parcel) and either
 * one may be the figure the bank shows. See `matchAmazonCharge` for why holding
 * both does NOT make the order ambiguous.
 */
function ledgerKey(r: AmazonOrderRecord): string {
  return `${r.orderId}|${r.kind}|${r.totalCents}`;
}

/** Default matching window, in days either side of the email. */
export const AMAZON_MATCH_WINDOW_DAYS = 5;
/** How long an unmatched record is kept before it is assumed never to match. */
export const AMAZON_LEDGER_RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;

/**
 * Fold newly parsed orders into the ledger.
 *
 * Idempotent by key: re-reading a message that was already ingested — which
 * happens whenever a mailbox is re-scanned — updates nothing and in particular
 * does not resurrect a consumed record as a fresh candidate.
 */
export function mergeAmazonOrders(
  ledger: AmazonLedger,
  records: AmazonOrderRecord[],
  emailDate: string,
): { ledger: AmazonLedger; added: number } {
  const next: AmazonLedger = { ...ledger };
  let added = 0;
  for (const r of records) {
    const key = ledgerKey(r);
    if (next[key]) continue;
    next[key] = { ...r, emailDate };
    added += 1;
  }
  return { ledger: next, added };
}

/** Drop records older than the retention window, matched or not. */
export function pruneAmazonLedger(
  ledger: AmazonLedger,
  nowMs: number,
  days = AMAZON_LEDGER_RETENTION_DAYS,
): { ledger: AmazonLedger; removed: number } {
  const cutoff = nowMs - days * DAY_MS;
  const next: AmazonLedger = {};
  let removed = 0;
  for (const [key, rec] of Object.entries(ledger)) {
    const t = Date.parse(rec.emailDate);
    if (Number.isFinite(t) && t < cutoff) { removed += 1; continue; }
    next[key] = rec;
  }
  return { ledger: next, removed };
}

export interface AmazonChargeQuery {
  /** The bank's description for the charge. */
  description: string;
  /** Magnitude in cents — sign is the caller's business. */
  amountCents: number;
  /** When the charge posted, epoch ms. */
  postedMs: number;
  /** `accountTxKey(sfAccountId, txId)` — the identity a match is recorded against. */
  txKey: string;
}

export interface AmazonMatch {
  orderId: string;
  labels: string[];
  /** Amazon withheld part of the category list (`…, and other items`). */
  partial?: boolean;
  /** Every ledger key that describes this order, so all of them can be consumed. */
  keys: string[];
}

/**
 * The Amazon order a charge is, or null.
 *
 * AMBIGUITY IS MEASURED PER ORDER, NOT PER RECORD. Holding both a confirmation and
 * a shipment notice for one order means two records with the same total, and
 * counting records would have made the ordinary single-shipment case — the
 * overwhelming majority — look like two rival candidates and get skipped. Two
 * records of ONE order are the same money described twice; only two distinct order
 * ids at the same amount in the same window are genuinely ambiguous.
 *
 * When they are, nothing is returned. Two Amazon orders for $21.18 five days apart
 * cannot be told apart from the bank side, and a wrong category is invisible —
 * indistinguishable from a right one — where a missing one merely shows up in the
 * needs-a-category sweep. Skipping is the recoverable direction.
 *
 * A record already consumed by a DIFFERENT transaction is not offered again: the
 * charge it belongs to has been found, and a second charge of the same amount is a
 * separate purchase. Consumed by this same `txKey` still matches, so re-running a
 * sync is idempotent.
 */
export function matchAmazonCharge(
  ledger: AmazonLedger,
  query: AmazonChargeQuery,
  windowDays = AMAZON_MATCH_WINDOW_DAYS,
): AmazonMatch | null {
  if (!isAmazonDescription(query.description)) return null;
  const window = windowDays * DAY_MS;

  const byOrder = new Map<string, { labels: string[]; partial?: boolean; keys: string[] }>();
  for (const [key, rec] of Object.entries(ledger)) {
    if (rec.totalCents !== query.amountCents) continue;
    if (rec.consumedBy && rec.consumedBy !== query.txKey) continue;
    const emailMs = Date.parse(rec.emailDate);
    if (!Number.isFinite(emailMs)) continue;
    if (Math.abs(query.postedMs - emailMs) > window) continue;
    const seen = byOrder.get(rec.orderId);
    if (seen) seen.keys.push(key);
    else byOrder.set(rec.orderId, { labels: rec.labels, partial: rec.partial, keys: [key] });
  }

  if (byOrder.size !== 1) return null;
  const [orderId, hit] = [...byOrder.entries()][0];
  return { orderId, labels: hit.labels, partial: hit.partial, keys: hit.keys };
}

/** Record that an order's charge was found, so it is not offered to another. */
export function consumeAmazonMatch(
  ledger: AmazonLedger,
  match: AmazonMatch,
  txKey: string,
): AmazonLedger {
  const next: AmazonLedger = { ...ledger };
  for (const key of match.keys) {
    if (next[key]) next[key] = { ...next[key], consumedBy: txKey };
  }
  return next;
}

/**
 * The description to store, with the order's categories folded in.
 *
 * APPENDED, never substituted: the bank's own text is what the user recognises on
 * a statement, and it is also what every `mapTransactionRules` merchant rule
 * matches on, so replacing it would silently change how existing rules type the
 * row.
 *
 * `Amazon:` prefixes the label so the one-time Wealthfolio categorization rule can
 * match something unmistakable. A bare `Lawn & Garden` would also match a genuine
 * garden centre's charge.
 *
 * A MIXED order is deliberately written differently — `Amazon: mixed — A + B` —
 * and the reason is mechanical, not cosmetic. Wealthfolio's rules match on
 * substrings, so `Amazon: Home Improvement + Bath` would fire the
 * `Amazon: Home Improvement` rule and file the whole charge under Housing. But the
 * per-label amounts do not exist in the email, so that is a guess: a $200 order
 * could be $190 of electronics and $10 of groceries or the reverse, and nothing
 * here can tell. Putting `mixed` immediately after the colon means no
 * single-category rule can match, so the charge keeps its readable categories and
 * lands in the needs-a-category sweep for a human to split — which is honest,
 * where an invisible guess on real money is not.
 */
export function amazonDescription(
  description: string,
  labels: string[],
  partial = false,
): string {
  if (labels.length === 0) return description;
  if (labels.length === 1 && !partial) {
    return `${description} · Amazon: ${labels[0]}`;
  }
  // "+ more" when Amazon withheld the rest, so the list never looks exhaustive.
  return `${description} · Amazon: mixed — ${labels.join(' + ')}${partial ? ' + more' : ''}`;
}
