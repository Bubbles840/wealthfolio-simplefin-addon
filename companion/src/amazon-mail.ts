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
import { classifyAmazonEmail } from '../../shared/amazon.js';
import {
  resolveAmazonCategory, amazonMailConfigured, AMAZON_SENDERS, isAmazonMessage,
  AMAZON_CONFIG_SECRET_KEY, AMAZON_LABELS_SECRET_KEY, DEFAULT_AMAZON_CATEGORY,
} from '../../shared/amazon-config.js';
import type { AmazonMailConfig, AmazonLabelCatalog } from '../../shared/amazon-config.js';
// Re-exported so the companion's own modules keep one import site for all of
// this, even though the host-agnostic half now lives in shared/.
export {
  resolveAmazonCategory, amazonMailConfigured, AMAZON_SENDERS, isAmazonMessage,
  AMAZON_CONFIG_SECRET_KEY, AMAZON_LABELS_SECRET_KEY, DEFAULT_AMAZON_CATEGORY,
};
export type { AmazonMailConfig, AmazonLabelCatalog };

/** One message, already MIME-decoded to plain text. */
export interface MailMessage {
  uid: number;
  /**
   * The folder it came from.
   *
   * Required, not decorative: IMAP UIDs are scoped PER MAILBOX, so uid 5 in Spam
   * and uid 5 in INBOX are different messages. Flagging by uid alone once more than
   * one folder is scanned marks the wrong message read — the parsed order gets
   * re-ingested forever while an unrelated one is hidden from the next poll.
   */
  mailbox: string;
  /** The message's own date — the anchor the ±5 day match window measures from. */
  date: string;
  text: string;
  /**
   * Sender, lowercased.
   *
   * Carried purely for diagnostics, and it earns its keep: "the parser broke" and
   * "a sender I never forwarded started carrying order emails" are the same
   * symptom — messages arriving that yield no orders — and without the sender
   * there is no way to tell them apart. Amazon uses a dozen addresses and the set
   * is not documented anywhere.
   */
  from?: string;
}

export interface MailSource {
  /** Amazon messages not yet ingested, oldest first. */
  fetch(): Promise<MailMessage[]>;
  /** Flag messages as read so the next poll skips them. Takes whole messages
   *  rather than uids, because a uid means nothing without its mailbox. */
  markSeen(messages: MailMessage[]): Promise<void>;
  close(): Promise<void>;
}

/** What a poll found, for logging and for the daily digest. */
export interface AmazonIngestResult {
  scanned: number;
  /** Orders added to the ledger this poll. */
  added: number;
  /** Messages whose shape the parser did not recognise — a possible format change. */
  unparsed: number;
  /** Amazon notices that by their nature carry no total (delivery confirmations).
   *  Expected, not failures, and flagged read so they stop accumulating. */
  ignored: number;
  pruned: number;
  /** Labels seen for the first time ever, with where they were filed. */
  newLabels: Array<{ label: string; category: string; matched: boolean }>;
  /** Senders whose messages yielded no orders, with a count each. */
  unparsedSenders: Record<string, number>;
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
    scanned: messages.length, added: 0, unparsed: 0, ignored: 0, pruned: 0,
    newLabels: [], unparsedSenders: {},
  };
  const consumed: MailMessage[] = [];

  for (const msg of messages) {
    const { orders, status } = classifyAmazonEmail(msg.text);
    if (status !== 'orders') {
      // A delivery notice restates no price, so it can never match a charge. Read
      // and dropped rather than counted as a failure: every order produces one, and
      // leaving them unread would fill the mailbox and bury a real format change
      // under permanent noise.
      if (status === 'ignored') {
        result.ignored += 1;
        consumed.push(msg);
        continue;
      }
      result.unparsed += 1;
      const who = msg.from ?? 'unknown sender';
      result.unparsedSenders[who] = (result.unparsedSenders[who] ?? 0) + 1;
      continue;
    }
    // Date only: the window is measured in days, and keeping a time-of-day would
    // make a purchase near midnight behave differently from the same purchase at
    // noon for no reason a user could ever predict.
    const emailDate = new Date(msg.date).toISOString().slice(0, 10);
    const merged = mergeAmazonOrders(ledger, orders, emailDate);
    ledger = merged.ledger;
    result.added += merged.added;
    consumed.push(msg);

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
  if (consumed.length > 0) await source.markSeen(consumed);

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

  /**
   * INBOX **and** the spam folder.
   *
   * Forwarded mail gets spam-flagged routinely — Amazon's own message arriving from
   * a different account is exactly the pattern spam heuristics dislike, and it
   * happened on the very first test forward. Reading INBOX only meant those orders
   * were invisible, which is indistinguishable from "the parser broke" and is the
   * kind of thing a user hits before they have any reason to trust the feature.
   *
   * A `never send it to Spam` filter on the receipts mailbox is still the better
   * fix, and the setup guide asks for one. But a feature that silently does nothing
   * when the user forgets one optional filter is a feature that silently does
   * nothing, so this covers it either way.
   *
   * The risk accepted: spam CAN contain a forged Amazon receipt. The cost of one is
   * a wrong category on a charge whose amount it happened to guess — never money
   * moved — and the mailbox is an address nobody but Amazon and the user's own
   * filter writes to.
   */
  const mailboxes = ['INBOX'];
  try {
    for (const box of await client.list()) {
      if (box.specialUse === '\\Junk' && box.path !== 'INBOX') mailboxes.push(box.path);
    }
  } catch {
    // No LIST support, or a server that hides folders: INBOX alone still works.
  }

  /** Scan one mailbox. Holds its lock only while reading it. */
  async function scan(mailbox: string): Promise<MailMessage[]> {
    const out: MailMessage[] = [];
    const lock = await client.getMailboxLock(mailbox);
    try {
      // UNSEEN only. The ledger's own key makes re-ingestion harmless, so this is
      // purely about not re-downloading and re-parsing everything every sync.
      const uids = await client.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) return out;
      for await (const msg of client.fetch(
        { uid: uids.join(',') },
        { uid: true, envelope: true, source: true },
      )) {
        const from = (msg.envelope?.from ?? [])
          .map((a) => String(a.address ?? '').toLowerCase());
        const parsed = await simpleParser(msg.source!);
        // Prefer text/plain. Amazon sends the same fields in both parts, and the
        // HTML part would need tag-stripping that can join words together.
        const text = parsed.text ?? (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, '\n') : '');
        // Sender check here rather than in the IMAP search: the forwarding mailbox
        // should contain nothing else, but "should" is not a reason to parse
        // whatever else lands in it. Needs the decoded body too, so a hand-forwarded
        // order — whose From: is the person who forwarded it — still counts.
        if (!isAmazonMessage(from[0], text)) continue;
        out.push({
          uid: msg.uid,
          mailbox,
          date: (parsed.date ?? new Date()).toISOString(),
          text,
          from: from[0],
        });
      }
    } finally {
      lock.release();
    }
    return out;
  }

  return {
    async fetch(): Promise<MailMessage[]> {
      const out: MailMessage[] = [];
      for (const mailbox of mailboxes) {
        // One unreadable folder must not lose the others.
        try {
          out.push(...(await scan(mailbox)));
        } catch {
          // Ignored: the mailbox may have vanished between LIST and SELECT.
        }
      }
      return out;
    },
    async markSeen(messages: MailMessage[]): Promise<void> {
      // Grouped by mailbox, because uids only mean anything inside one.
      const byBox = new Map<string, number[]>();
      for (const m of messages) {
        const list = byBox.get(m.mailbox);
        if (list) list.push(m.uid);
        else byBox.set(m.mailbox, [m.uid]);
      }
      for (const [mailbox, uids] of byBox) {
        const lock = await client.getMailboxLock(mailbox);
        try {
          await client.messageFlagsAdd({ uid: uids.join(',') }, ['\\Seen'], { uid: true });
        } finally {
          lock.release();
        }
      }
    },
    async close(): Promise<void> {
      await client.logout().catch(() => {});
    },
  };
}
