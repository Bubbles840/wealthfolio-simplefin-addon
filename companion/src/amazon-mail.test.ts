import { describe, it, expect } from 'vitest';
import {
  ingestAmazonMail,
  resolveAmazonCategory,
  amazonMailConfigured,
  type MailMessage,
  type MailSource,
  type IngestStore,
  type AmazonLabelCatalog,
} from './amazon-mail.js';
import type { AmazonLedger } from '../../shared/amazon-ledger.js';

const email = (orderId: string, label: string, total: string) =>
  `Thanks for your order!\nOrder # ‫${orderId}\n⁦1⁩ ${label} item\nGrand Total:\t$${total}`;

function fakeSource(messages: MailMessage[]) {
  const seen: number[] = [];
  const source: MailSource = {
    async fetch() { return messages; },
    async markSeen(uids) { seen.push(...uids); },
    async close() {},
  };
  return { source, seen };
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
    expect(seen).toEqual([11]);
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
