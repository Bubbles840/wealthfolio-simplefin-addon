/**
 * companion/src/amazon-mail.ts
 *
 * Filling the Amazon order ledger from a forwarding mailbox.
 *
 * WHY A SEPARATE MAILBOX, and not the user's own inbox. No mail API offers a
 * per-sender scope: `gmail.readonly` and an IMAP app password both grant the whole
 * account. Reading ~20 Amazon receipts a month is not worth that, least of all in
 * an addon other people install. So the user adds ONE Gmail filter forwarding
 * Amazon's two order senders to a throwaway address, and the companion holds
 * credentials for that address only — which contains nothing but receipts. A
 * compromise exposes receipts; revoking is deleting one filter.
 *
 * The IO is deliberately thin and the decisions all live in `ingestAmazonMail`,
 * which takes a `MailSource` — so the logic is testable without an IMAP server and
 * the untested surface is just the adapter at the bottom of this file.
 */

import {
  mergeAmazonOrders, pruneAmazonLedger, type AmazonLedger,
} from '../../shared/amazon-ledger.js';
import { parseAmazonEmail } from '../../shared/amazon.js';
import {
  resolveAmazonCategory, amazonMailConfigured, AMAZON_SENDERS,
  AMAZON_CONFIG_SECRET_KEY, AMAZON_LABELS_SECRET_KEY, DEFAULT_AMAZON_CATEGORY,
} from '../../shared/amazon-config.js';
import type { AmazonMailConfig, AmazonLabelCatalog } from '../../shared/amazon-config.js';
// Re-exported so the companion's own modules keep one import site for all of
// this, even though the host-agnostic half now lives in shared/.
export {
  resolveAmazonCategory, amazonMailConfigured, AMAZON_SENDERS,
  AMAZON_CONFIG_SECRET_KEY, AMAZON_LABELS_SECRET_KEY, DEFAULT_AMAZON_CATEGORY,
};
export type { AmazonMailConfig, AmazonLabelCatalog };

/** One message, already MIME-decoded to plain text. */
export interface MailMessage {
  uid: number;
  /** The message's own date — the anchor the ±5 day match window measures from. */
  date: string;
  text: string;
}

export interface MailSource {
  /** Amazon messages not yet ingested, oldest first. */
  fetch(): Promise<MailMessage[]>;
  /** Flag messages as read so the next poll skips them. */
  markSeen(uids: number[]): Promise<void>;
  close(): Promise<void>;
}

/** What a poll found, for logging and for the daily digest. */
export interface AmazonIngestResult {
  scanned: number;
  /** Orders added to the ledger this poll. */
  added: number;
  /** Messages whose shape the parser did not recognise. */
  unparsed: number;
  pruned: number;
  /** Labels seen for the first time ever, with where they were filed. */
  newLabels: Array<{ label: string; category: string; matched: boolean }>;
}

export interface IngestStore {
  getAmazonLedger(): Promise<AmazonLedger>;
  setAmazonLedger(map: AmazonLedger): Promise<void>;
  getAmazonLabels(): Promise<AmazonLabelCatalog>;
  setAmazonLabels(map: AmazonLabelCatalog): Promise<void>;
}

/**
 * Read the mailbox into the ledger.
 *
 * A message that fails to parse is COUNTED and left unread rather than skipped
 * silently: Amazon changed this format on 2026-07-08 and may again, and the
 * failure has to be visible in the log instead of presenting as "categorization
 * quietly stopped working". Only messages that yielded orders are flagged read.
 */
export async function ingestAmazonMail(
  source: MailSource,
  store: IngestStore,
  cfg: AmazonMailConfig,
  nowMs: number,
): Promise<AmazonIngestResult> {
  const messages = await source.fetch();
  let ledger = await store.getAmazonLedger();
  const labels = { ...(await store.getAmazonLabels()) };

  const result: AmazonIngestResult = {
    scanned: messages.length, added: 0, unparsed: 0, pruned: 0, newLabels: [],
  };
  const consumedUids: number[] = [];

  for (const msg of messages) {
    const orders = parseAmazonEmail(msg.text);
    if (orders.length === 0) { result.unparsed += 1; continue; }
    // Date only: the window is measured in days, and keeping a time-of-day would
    // make a purchase near midnight behave differently from the same purchase at
    // noon for no reason a user could ever predict.
    const emailDate = new Date(msg.date).toISOString().slice(0, 10);
    const merged = mergeAmazonOrders(ledger, orders, emailDate);
    ledger = merged.ledger;
    result.added += merged.added;
    consumedUids.push(msg.uid);

    for (const order of orders) {
      for (const label of order.labels) {
        if (labels[label]) continue;
        const { category, matched } = resolveAmazonCategory(label, cfg);
        labels[label] = { category, matched };
        // Reported ONCE, on first sighting, so an unmatched label is visible and
        // one pattern away from correct — never silently sitting in the default.
        result.newLabels.push({ label, category, matched });
      }
    }
  }

  const pruned = pruneAmazonLedger(ledger, nowMs);
  result.pruned = pruned.removed;

  if (result.added > 0 || pruned.removed > 0) await store.setAmazonLedger(pruned.ledger);
  if (result.newLabels.length > 0) await store.setAmazonLabels(labels);
  if (consumedUids.length > 0) await source.markSeen(consumedUids);

  return result;
}

/**
 * The real IMAP adapter.
 *
 * Kept to fetching and flagging, with no decisions in it, because it is the one
 * part of this feature that cannot be covered by a test without standing up a mail
 * server. `mailparser` does the MIME decoding rather than any hand-rolled
 * unwrapping: Amazon's bodies are quoted-printable, so the U+202B/U+2066 marks
 * arrive as `=E2=80=AB` sequences and lines are broken with soft `=` continuations
 * — both of which silently corrupt the text the parser is looking at.
 */
export async function createImapSource(cfg: AmazonMailConfig): Promise<MailSource> {
  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');

  const client = new ImapFlow({
    host: cfg.host!,
    port: cfg.port ?? 993,
    secure: true,
    auth: { user: cfg.user!, pass: cfg.password! },
    // The companion's own log is the diagnostic channel; imapflow's per-command
    // pino stream would bury it.
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');

  return {
    async fetch(): Promise<MailMessage[]> {
      const out: MailMessage[] = [];
      // UNSEEN only. The ledger's own key makes re-ingestion harmless, so this is
      // purely about not re-downloading and re-parsing the whole mailbox every
      // fifteen minutes.
      const uids = await client.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) return out;
      for await (const msg of client.fetch(
        { uid: uids.join(',') },
        { uid: true, envelope: true, source: true },
      )) {
        const from = (msg.envelope?.from ?? [])
          .map((a) => String(a.address ?? '').toLowerCase());
        // Sender check here rather than in the IMAP search: the forwarding mailbox
        // should contain nothing else, but "should" is not a reason to parse
        // whatever else lands in it.
        if (!from.some((a) => AMAZON_SENDERS.includes(a) || a.endsWith('@amazon.com'))) continue;
        const parsed = await simpleParser(msg.source!);
        // Prefer text/plain. Amazon sends the same fields in both parts, and the
        // HTML part would need tag-stripping that can join words together.
        const text = parsed.text ?? (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, '\n') : '');
        out.push({
          uid: msg.uid,
          date: (parsed.date ?? new Date()).toISOString(),
          text,
        });
      }
      return out;
    },
    async markSeen(uids: number[]): Promise<void> {
      if (uids.length === 0) return;
      await client.messageFlagsAdd({ uid: uids.join(',') }, ['\\Seen'], { uid: true });
    },
    async close(): Promise<void> {
      lock.release();
      await client.logout().catch(() => {});
    },
  };
}
