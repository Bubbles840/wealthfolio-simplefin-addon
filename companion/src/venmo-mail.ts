/**
 * companion/src/venmo-mail.ts
 *
 * Filling the Venmo ledger from the same forwarding mailbox Amazon's orders
 * use (project 3): the person adds a second Gmail filter, `from:venmo@venmo.com`
 * → forward to that address. On whenever the Amazon mailbox is configured; it
 * only ever acts on Venmo mail that arrives there.
 *
 * The decisions live in `ingestVenmoMail` over a `MailSource` view (see
 * `shareMailSource` in ./amazon-mail.ts), exactly as `ingestAmazonMail`: a
 * payment is merged and its message flagged read, other Venmo mail is flagged
 * read and counted as ignored, and one that looks like a payment but does not
 * read stays UNREAD and becomes a sample.
 */
import { classifyVenmoEmail, isVenmoMessage, toVenmoMailSample } from '../../shared/venmo.js';
import { isReadableVenmoLedger, mergeVenmoRecords, pruneVenmoLedger, type VenmoLedger } from '../../shared/venmo-ledger.js';
import { AMAZON_SAMPLE_LIMIT } from '../../shared/amazon-sample.js';
import type { AmazonMailSample } from '../../shared/status-keys.js';
import { mailBody, type MailMessage, type MailSource } from './amazon-mail.js';

/** Whether a fetched message is Venmo's: its sender, or a hand-forwarded copy. */
export function isVenmoMail(m: MailMessage): boolean {
  return isVenmoMessage(m.from, mailBody(m));
}

export interface VenmoIngestStore {
  getVenmoLedger(): Promise<VenmoLedger>;
  setVenmoLedger(map: VenmoLedger): Promise<void>;
}

/** What a poll found, for the log line and the samples secret. */
export interface VenmoIngestResult {
  scanned: number;
  /** Payments added to the ledger this poll. */
  added: number;
  /** Venmo mail that moves no money: flagged read. */
  ignored: number;
  /** Looked like a payment and did not read: left unread. */
  unparsed: number;
  pruned: number;
  /** Redacted copies of the unread ones, newest `AMAZON_SAMPLE_LIMIT`. */
  samples: AmazonMailSample[];
}

/** Read the Venmo messages into the ledger. Only messages it understood are
 *  flagged read; the ledger is written only when something changed. Throws,
 *  having written and flagged nothing, when the ledger cannot be read. */
export async function ingestVenmoMail(
  source: MailSource,
  store: VenmoIngestStore,
  nowMs: number,
): Promise<VenmoIngestResult> {
  const messages = await source.fetch();
  let ledger = await store.getVenmoLedger();
  // A ledger holding bad entries is never merged into, pruned or rewritten (the
  // hosts already throw on a document that does not parse): abort with no write
  // and no markSeen, so the messages are retried once it is fixed. The caller's
  // guard logs the throw once.
  if (!isReadableVenmoLedger(ledger)) throw new Error('the Venmo payments list has unreadable entries; left as it is');
  const result: VenmoIngestResult = { scanned: messages.length, added: 0, ignored: 0, unparsed: 0, pruned: 0, samples: [] };
  const consumed: MailMessage[] = [];

  for (const msg of messages) {
    const { status, record } = classifyVenmoEmail(msg.parts);
    if (status === 'ignored') {
      result.ignored += 1;
      consumed.push(msg);
      continue;
    }
    if (status !== 'payment' || !record) {
      result.unparsed += 1;
      result.samples.push(toVenmoMailSample(msg));
      continue;
    }
    // The email's day: the match window (a day before to five after) is measured in days, as Amazon's is.
    const merged = mergeVenmoRecords(ledger, [record], new Date(msg.date).toISOString().slice(0, 10));
    ledger = merged.ledger;
    result.added += merged.added;
    consumed.push(msg);
  }

  result.samples = result.samples.slice(-AMAZON_SAMPLE_LIMIT);
  const pruned = pruneVenmoLedger(ledger, nowMs);
  result.pruned = pruned.removed;
  if (result.added > 0 || pruned.removed > 0) await store.setVenmoLedger(pruned.ledger);
  if (consumed.length > 0) await source.markSeen(consumed);
  return result;
}
