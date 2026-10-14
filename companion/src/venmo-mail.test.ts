import { describe, it, expect, vi } from 'vitest';
import { mailBody, shareMailSource, type MailMessage, type MailSource } from './amazon-mail.js';
import { ingestVenmoMail, isVenmoMail, type VenmoIngestStore } from './venmo-mail.js';
import type { VenmoLedger } from '../../shared/venmo-ledger.js';

// Built from Venmo's documented wording, not a real email (follow-ups §13).
const PAID: MailMessage = {
  uid: 11, mailbox: 'INBOX', date: '2026-10-03T18:22:00Z', from: 'venmo@venmo.com',
  parts: { subject: 'You paid Jane Doe $25.00', plain: 'You paid Jane Doe\n$25.00\nRent October\nSee transaction\n' },
};
const SECURITY: MailMessage = {
  uid: 12, mailbox: 'INBOX', date: '2026-10-03T19:00:00Z', from: 'venmo@venmo.com',
  parts: { subject: 'Your Venmo security code', plain: 'Your code is 123456.' },
};
const UNREADABLE: MailMessage = {
  uid: 13, mailbox: '[Gmail]/Spam', date: '2026-10-04T08:00:00Z', from: 'venmo@venmo.com',
  parts: { subject: 'You paid Sam Lee $9.00', plain: 'A layout nobody has seen.\n' },
};
const AMAZON: MailMessage = {
  uid: 14, mailbox: 'INBOX', date: '2026-10-04T09:00:00Z', from: 'auto-confirm@amazon.com',
  parts: { plain: 'Thanks for your order!' },
};
const NOW = Date.parse('2026-10-14T12:00:00Z');

function fakeSource(messages: MailMessage[]) {
  const seen: MailMessage[] = [];
  const source: MailSource = {
    fetch: vi.fn(async () => messages),
    async markSeen(msgs) { seen.push(...msgs); },
    async close() {},
  };
  return { source, seen: () => seen };
}

function fakeStore(ledger: VenmoLedger = {}) {
  const state = { ledger, writes: 0 };
  const store: VenmoIngestStore = {
    async getVenmoLedger() { return state.ledger; },
    async setVenmoLedger(map) { state.ledger = map; state.writes += 1; },
  };
  return { store, state };
}

describe('ingestVenmoMail', () => {
  it('merges a payment on the email’s day, flags it and ignored mail read, and keeps the unreadable one unread as a sample', async () => {
    const { source, seen } = fakeSource([PAID, SECURITY, UNREADABLE]);
    const { store, state } = fakeStore();
    const r = await ingestVenmoMail(source, store, NOW);
    expect(r).toMatchObject({ scanned: 3, added: 1, ignored: 1, unparsed: 1, pruned: 0 });
    expect(Object.values(state.ledger)).toEqual([{
      direction: 'out', kind: 'payment', amountCents: 2500, counterparty: 'Jane Doe', note: 'Rent October', emailDate: '2026-10-03',
    }]);
    expect(seen().map((m) => m.uid)).toEqual([11, 12]);
    expect(r.samples).toEqual([{ at: '2026-10-04T08:00:00Z', from: 'venmo@venmo.com', subject: 'You paid Sam Lee $9.00', plain: 'A layout nobody has seen.', html: '' }]);
  });

  it('stores the email’s UTC day, not the local one', async () => {
    const late: MailMessage = { ...PAID, date: '2026-10-03T23:30:00-05:00' };
    const { store, state } = fakeStore();
    await ingestVenmoMail(fakeSource([late]).source, store, NOW);
    expect(Object.values(state.ledger).map((r) => r.emailDate)).toEqual(['2026-10-04']);
  });

  it('never rewrites a ledger holding bad entries: it aborts with no write and no markSeen', async () => {
    const bad = { x: { direction: 'sideways', amountCents: 1, note: '', emailDate: '2026-10-01' } } as unknown as VenmoLedger;
    const { source, seen } = fakeSource([PAID, SECURITY]);
    const { store, state } = fakeStore(bad);
    await expect(ingestVenmoMail(source, store, NOW)).rejects.toThrow(/Venmo payments list/);
    expect(state.writes).toBe(0);
    expect(state.ledger).toBe(bad);
    expect(seen()).toEqual([]);
  });

  it('a corrupt ledger (the host throws) aborts: no write, no markSeen, retried later', async () => {
    const { source, seen } = fakeSource([PAID]);
    const writes: number[] = [];
    const store: VenmoIngestStore = {
      async getVenmoLedger() { throw new Error('the Venmo payments list is not an object'); },
      async setVenmoLedger() { writes.push(1); },
    };
    await expect(ingestVenmoMail(source, store, NOW)).rejects.toThrow();
    expect(writes).toEqual([]);
    expect(seen()).toEqual([]);
  });

  it('adds nothing for an email it already read, and writes nothing when nothing changed', async () => {
    const first = fakeStore();
    await ingestVenmoMail(fakeSource([PAID]).source, first.store, NOW);
    const again = await ingestVenmoMail(fakeSource([PAID]).source, first.store, NOW);
    expect(again.added).toBe(0);
    expect(first.state.writes).toBe(1);
  });

  it('prunes payments older than 90 days', async () => {
    const { store, state } = fakeStore({
      old: { direction: 'out', kind: 'payment', amountCents: 100, counterparty: 'X', note: 'Old', emailDate: '2026-06-01' },
    });
    const r = await ingestVenmoMail(fakeSource([]).source, store, NOW);
    expect(r.pruned).toBe(1);
    expect(state.ledger).toEqual({});
  });
});

describe('one mailbox, two readers', () => {
  it('reads the mailbox once and gives each reader only its own messages', async () => {
    const { source, seen } = fakeSource([PAID, AMAZON]);
    const shared = shareMailSource(source);
    const amazon = await shared.view((m) => m.from === 'auto-confirm@amazon.com').fetch();
    const venmoView = shared.view(isVenmoMail);
    expect((await venmoView.fetch()).map((m) => m.uid)).toEqual([11]);
    expect(amazon.map((m) => m.uid)).toEqual([14]);
    expect(source.fetch).toHaveBeenCalledTimes(1);
    await venmoView.markSeen([PAID]);
    expect(seen().map((m) => m.uid)).toEqual([11]);
  });

  it('knows a hand-forwarded Venmo email by its From: line', () => {
    const forwarded: MailMessage = { ...PAID, from: 'nick@gmail.com', parts: { plain: 'From: Venmo <venmo@venmo.com>\nYou paid Jane Doe' } };
    expect(isVenmoMail(forwarded)).toBe(true);
    expect(isVenmoMail(AMAZON)).toBe(false);
    expect(mailBody({ parts: { plain: 'a', html: 'b' } })).toBe('a\nb');
  });
});
