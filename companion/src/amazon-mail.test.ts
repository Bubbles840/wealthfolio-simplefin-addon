import { describe, it, expect } from 'vitest';
import {
  ingestAmazonMail,
  resolveAmazonCategory,
  amazonMailConfigured,
  isAmazonMessage,
  htmlToText,
  buildAmazonMailText,
  type MailMessage,
  type MailSource,
  type IngestStore,
  type AmazonLabelCatalog,
} from './amazon-mail.js';
import type { AmazonLedger } from '../../shared/amazon-ledger.js';

const email = (orderId: string, label: string, total: string) =>
  `Thanks for your order!\nOrder # ‫${orderId}\n⁦1⁩ ${label} item\nGrand Total:\t$${total}`;

function fakeSource(messages: Array<Omit<MailMessage, 'mailbox'> & { mailbox?: string }>) {
  const full: MailMessage[] = messages.map((m) => ({ mailbox: 'INBOX', ...m }));
  const seen: MailMessage[] = [];
  const source: MailSource = {
    async fetch() { return full; },
    async markSeen(msgs) { seen.push(...msgs); },
    async close() {},
  };
  return { source, seen: () => seen };
}

function fakeStore(ledger: AmazonLedger = {}, labels: AmazonLabelCatalog = {}) {
  const state = { ledger, labels };
  const store: IngestStore = {
    async getAmazonLedger() { return state.ledger; },
    async setAmazonLedger(map) { state.ledger = map; },
    async getAmazonLabels() { return state.labels; },
    async setAmazonLabels(map) { state.labels = map; },
  };
  return { store, state };
}

const NOW = Date.parse('2026-08-07T12:00:00Z');

describe('ingestAmazonMail', () => {
  it('turns messages into ledger records anchored on the email date', () => {
    const { source } = fakeSource([
      { uid: 11, date: '2026-08-04T18:22:00Z', text: email('113-0728509-1925031', 'Lawn & Garden', '21.18') },
    ]);
    const { store, state } = fakeStore();
    return ingestAmazonMail(source, store, {}, NOW).then((r) => {
      expect(r).toMatchObject({ scanned: 1, added: 1, unparsed: 0 });
      const rec = state.ledger['113-0728509-1925031|ordered|2118'];
      // Date only. A window measured in days must not behave differently for a
      // purchase at 23:50 than for the same one at noon.
      expect(rec.emailDate).toBe('2026-08-04');
      expect(rec.labels).toEqual(['Lawn & Garden']);
    });
  });

  it('names the sender of an unrecognised message, not just a count', async () => {
    // "The parser broke" and "a sender I never meant to forward is arriving" look
    // identical from a count — messages that yield no orders — and the fixes are
    // opposite. The sender is the only thing that tells them apart.
    const { source } = fakeSource([
      { uid: 11, date: '2026-08-04T00:00:00Z', text: 'Deals of the day!', from: 'store-news@amazon.com' },
      { uid: 12, date: '2026-08-05T00:00:00Z', text: 'More deals!', from: 'store-news@amazon.com' },
      { uid: 13, date: '2026-08-05T00:00:00Z', text: 'Nothing useful', from: 'auto-confirm@amazon.com' },
    ]);
    const { store } = fakeStore();
    const r = await ingestAmazonMail(source, store, {}, NOW);
    expect(r.unparsed).toBe(3);
    expect(r.unparsedSenders).toEqual({
      'store-news@amazon.com': 2,
      'auto-confirm@amazon.com': 1,
    });
  });

  it('flags ingested messages read but leaves an unparsed one unread', async () => {
    // An unrecognised message must stay visible. Amazon changed this format five
    // weeks ago; marking the failure read would turn the next change into
    // "categorization quietly stopped working" with nothing to look at.
    const { source, seen } = fakeSource([
      { uid: 11, date: '2026-08-04T00:00:00Z', text: email('113-0728509-1925031', 'Electronics', '10.55') },
      { uid: 12, date: '2026-08-05T00:00:00Z', text: 'Your Amazon account was accessed from a new device' },
    ]);
    const { store } = fakeStore();
    const r = await ingestAmazonMail(source, store, {}, NOW);
    expect(r.unparsed).toBe(1);
    expect(seen().map((m) => m.uid)).toEqual([11]);
  });

  it('flags by mailbox as well as uid, since uids collide across folders', async () => {
    // IMAP uids are scoped per mailbox, and this poll reads INBOX *and* Spam
    // (forwarded mail gets spam-flagged routinely — it happened on the very first
    // test forward). Two different messages can both be uid 5, so flagging by uid
    // alone marks the wrong one read: the parsed order re-ingests forever while an
    // unrelated message is hidden from the next poll.
    const { source, seen } = fakeSource([
      { uid: 5, mailbox: 'INBOX', date: '2026-08-04T00:00:00Z', text: email('113-0728509-1925031', 'Electronics', '10.55') },
      { uid: 5, mailbox: '[Gmail]/Spam', date: '2026-08-05T00:00:00Z', text: email('222-2222222-2222222', 'Grocery', '8.20') },
    ]);
    const { store } = fakeStore();
    const r = await ingestAmazonMail(source, store, {}, NOW);
    expect(r.added).toBe(2);
    expect(seen().map((m) => `${m.mailbox}:${m.uid}`))
      .toEqual(['INBOX:5', '[Gmail]/Spam:5']);
  });

  it('skips a delivery notice as expected, not as a parse failure', async () => {
    // Every order produces one, and they carry no total so they can never match a
    // charge. Counting them as failures would leave the mailbox filling with
    // permanently-unread mail and bury the one signal that says the parser broke.
    const { source, seen } = fakeSource([
      { uid: 21, date: '2026-08-06T00:00:00Z', text: 'Delivered: ⁦1⁩ Electronics item', from: 'order-update@amazon.com' },
    ]);
    const { store } = fakeStore();
    const r = await ingestAmazonMail(source, store, {}, NOW);
    expect(r.ignored).toBe(1);
    expect(r.unparsed).toBe(0);
    expect(r.unparsedSenders).toEqual({});
    // Flagged read, unlike a genuine parse failure, so they stop accumulating.
    expect(seen().map((m) => m.uid)).toEqual([21]);
  });

  it('reports a label the first time it is seen, and not again', async () => {
    const msgs = [{ uid: 11, date: '2026-08-04T00:00:00Z', text: email('113-0728509-1925031', 'Lawn & Garden', '21.18') }];
    const { store, state } = fakeStore();
    const first = await ingestAmazonMail(fakeSource(msgs).source, store, {}, NOW);
    expect(first.newLabels).toEqual([{ label: 'Lawn & Garden', category: 'Housing', matched: true }]);
    expect(state.labels['Lawn & Garden']).toEqual({ category: 'Housing', matched: true });

    const second = await ingestAmazonMail(
      fakeSource([{ uid: 12, date: '2026-08-05T00:00:00Z', text: email('222-2222222-2222222', 'Lawn & Garden', '9.99') }]).source,
      store, {}, NOW,
    );
    expect(second.newLabels).toEqual([]);
  });

  it('flags an unmatched label as unmatched while still filing it', async () => {
    // Both, not either: filed so nothing lands uncategorized, flagged so the
    // digest can say so and the user can add one pattern.
    const { source } = fakeSource([
      { uid: 11, date: '2026-08-04T00:00:00Z', text: email('113-0728509-1925031', 'Industrial & Scientific', '21.18') },
    ]);
    const { store } = fakeStore();
    const r = await ingestAmazonMail(source, store, {}, NOW);
    expect(r.newLabels).toEqual([
      { label: 'Industrial & Scientific', category: 'Shopping', matched: false },
    ]);
  });

  it('re-ingesting the same message adds nothing', async () => {
    const msgs = [{ uid: 11, date: '2026-08-04T00:00:00Z', text: email('113-0728509-1925031', 'Electronics', '10.55') }];
    const { store } = fakeStore();
    await ingestAmazonMail(fakeSource(msgs).source, store, {}, NOW);
    const again = await ingestAmazonMail(fakeSource(msgs).source, store, {}, NOW);
    expect(again.added).toBe(0);
  });

  it('prunes records past retention during the poll', async () => {
    const stale: AmazonLedger = {
      'old|shipped|100': {
        orderId: 'old', kind: 'shipped', totalCents: 100, itemCount: 1,
        labels: ['Electronics'], emailDate: '2026-01-01',
      },
    };
    const { store, state } = fakeStore(stale);
    const r = await ingestAmazonMail(fakeSource([]).source, store, {}, NOW);
    expect(r.pruned).toBe(1);
    expect(state.ledger).toEqual({});
  });
});

describe('isAmazonMessage', () => {
  it('accepts Amazon envelope senders', () => {
    expect(isAmazonMessage('auto-confirm@amazon.com', 'anything')).toBe(true);
    expect(isAmazonMessage('shipment-tracking@amazon.com', '')).toBe(true);
    // Any amazon.com address, since the sender set is undocumented and varies by
    // order type; the parser is the real gate.
    expect(isAmazonMessage('order-update-2@amazon.com', '')).toBe(true);
  });

  it('accepts an order a human forwarded by hand', () => {
    // The ONLY way to seed past orders or test the setup without waiting days for a
    // purchase: Gmail's "also apply to matching conversations" does not forward
    // existing mail. A hand forward rewrites From: to the forwarder, so an
    // envelope-only check would skip exactly the messages used to verify it works.
    const body = [
      '---------- Forwarded message ---------',
      'From: Amazon.com <auto-confirm@amazon.com>',
      'Date: Tue, 4 Aug 2026 at 18:22',
      'Subject: Ordered: "Garden Hose"',
      '',
      'Thanks for your order!',
    ].join('\n');
    expect(isAmazonMessage('nick@gmail.com', body)).toBe(true);
  });

  it('rejects mail that merely mentions Amazon', () => {
    expect(isAmazonMessage('phish@example.com', 'Your amazon.com order needs attention'))
      .toBe(false);
    expect(isAmazonMessage(undefined, 'no headers here')).toBe(false);
  });
});

describe('resolveAmazonCategory', () => {
  it('prefers a user override over the patterns', () => {
    expect(resolveAmazonCategory('Lawn & Garden', { labelOverrides: { 'Lawn & Garden': 'Yard' } }))
      .toEqual({ category: 'Yard', matched: true });
  });

  it('uses the configured default for an unmatched label', () => {
    expect(resolveAmazonCategory('Industrial & Scientific', { defaultCategory: 'Misc' }))
      .toEqual({ category: 'Misc', matched: false });
  });
});

describe('htmlToText', () => {
  it('decodes an ampersand entity, since the HTML writes labels as "Lawn &amp; Garden"', () => {
    // Load-bearing, not cosmetic: as of ~Aug 2026 the category label lives only in
    // the subject and the HTML. If this label came out undecoded ("Lawn &amp;
    // Garden") it would be a different string than its text/plain-era twin
    // ("Lawn & Garden"), and every rule in DEFAULT_AMAZON_LABEL_RULES matches on
    // the decoded text.
    const html = '<span class="rio-text rio-text-339">Lawn &amp; Garden item</span>';
    expect(htmlToText(html)).toContain('Lawn & Garden item');
  });

  it('turns tags into newlines so adjacent table cells do not run together', () => {
    const html = '<td>Grand Total:</td><td>$4.23</td>';
    expect(htmlToText(html)).toBe('\nGrand Total:\n\n$4.23\n');
  });

  it('drops style and script blocks instead of emitting their contents as text', () => {
    const html = '<style>.rio-text{color:#fff}</style><span>Essentials item</span>';
    const text = htmlToText(html);
    expect(text).not.toContain('color');
    expect(text).toContain('Essentials item');
  });
});

describe('buildAmazonMailText', () => {
  it('combines subject, plain text and html-derived text, each only when present', () => {
    const text = buildAmazonMailText(
      'Ordered: ⁦1⁩ Essentials item',
      'Thanks for your order!',
      '<span class="rio-text rio-text-339">⁦1⁩ Essentials item</span>',
    );
    expect(text).toContain('Ordered: ⁦1⁩ Essentials item');
    expect(text).toContain('Thanks for your order!');
    expect(text).toContain('⁦1⁩ Essentials item');
  });

  it('omits a part entirely when the message did not carry it', () => {
    expect(buildAmazonMailText(undefined, 'plain only', undefined)).toBe('plain only');
    expect(buildAmazonMailText('subject only', undefined, undefined)).toBe('subject only');
  });
});

describe('amazonMailConfigured', () => {
  it('needs a host, a user and a password', () => {
    expect(amazonMailConfigured({ host: 'imap.gmail.com', user: 'a@b.c', password: 'x' })).toBe(true);
    expect(amazonMailConfigured({ host: 'imap.gmail.com', user: 'a@b.c' })).toBe(false);
    expect(amazonMailConfigured(null)).toBe(false);
  });

  it('treats an explicit disable as off even when fully filled in', () => {
    expect(amazonMailConfigured({
      enabled: false, host: 'imap.gmail.com', user: 'a@b.c', password: 'x',
    })).toBe(false);
  });
});
