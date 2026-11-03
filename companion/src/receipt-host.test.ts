import { describe, it, expect } from 'vitest';
import { categoryChoices, createReceiptHost, RECEIPT_COPY, type ReceiptHostDeps, type ReceiptUi } from './receipt-host.js';
import {
  RECEIPT_CONFIG_SECRET_KEY, RECEIPT_STATE_SECRET_KEY, RECEIPT_STATUS_SECRET_KEY, NO_CATEGORY, parseReceiptState, type ReceiptCategory, type SplitLine,
} from '../../shared/receipt-flow.js';
import type { ReceiptTranscript } from '../../shared/receipt.js';
import type { ActivityWrite } from '../../shared/sync-host.js';
import type { SpendRow } from '../../shared/wf-spending.js';
import { PENDING_SUFFIX } from '../../shared/sync-core.js';
import type { InlineKeyboard } from '../../shared/telegram.js';

const NOW = new Date('2027-03-15T15:00:00Z');
const CATS: ReceiptCategory[] = [
  { id: 'c-gro', name: 'Groceries', parentId: null },
  { id: 'c-home', name: 'Home', parentId: null },
  { id: 'c-lamps', name: 'Lamps & Lighting', parentId: 'c-home' },
];

const TILL: ReceiptTranscript = {
  store: 'Corner Market', date: '2027-03-14',
  lines: [
    { kind: 'item', text: 'BREAD', amount: '10.00' },
    { kind: 'item', text: 'LAMP', amount: '100.00', flag: 'A' },
  ],
  subtotal: '110.00', tax: '10.00', total: '120.00',
  taxLines: [{ flag: 'A', rate: '10%', amount: '10.00' }],
  payments: [{ label: 'VISA', amount: '120.00' }],
};

const charge = (over: Partial<SpendRow> = {}): SpendRow => ({
  id: 'charge-1', date: '2027-03-15T12:00:00+00:00', accountId: 'card', accountName: 'Card', accountType: 'CREDIT_CARD',
  type: 'WITHDRAWAL', subtype: '', groupId: '', absCents: 12000, notes: '', filings: [], splits: [], ...over,
});

interface Harness {
  deps: ReceiptHostDeps;
  host: ReturnType<typeof createReceiptHost>;
  secrets: Map<string, string>;
  sent: Array<{ text: string; keyboard?: InlineKeyboard }>;
  splits: Array<{ id: string; lines: SplitLine[] }>;
  created: ActivityWrite[];
  assigned: Array<[string, string]>;
  calls: string[];
  set: (o: {
    online?: boolean; transcript?: ReceiptTranscript | string; categories?: string[]; rows?: SpendRow[];
    spending?: string[]; fed?: string[]; refuseCreate?: boolean; now?: Date;
  }) => void;
}

function harness(): Harness {
  const secrets = new Map<string, string>([[RECEIPT_CONFIG_SECRET_KEY, JSON.stringify({ enabled: true, url: 'http://mac:11434', model: 'm' })]]);
  const sent: Harness['sent'] = [];
  const splits: Harness['splits'] = [];
  const created: ActivityWrite[] = [];
  const assigned: Array<[string, string]> = [];
  const calls: string[] = [];
  let online = true;
  let transcript: ReceiptTranscript | string = TILL;
  let categories = ['groceries', 'home_lamps_lighting'];
  let rows: SpendRow[] = [charge()];
  let spending = ['card', 'gift-acct', 'checking'];
  let fed: string[] = ['checking'];
  let refuseCreate = false;
  let now = NOW;
  let nextId = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    if (!online) throw new Error('ECONNREFUSED');
    if (String(url).endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'm:latest' }] }), { status: 200 });
    const body = JSON.parse(String(init?.body));
    const content = body.messages[0].images
      ? (typeof transcript === 'string' ? transcript : JSON.stringify(transcript))
      : JSON.stringify({ categories });
    return new Response(JSON.stringify({ message: { content } }), { status: 200 });
  }) as unknown as typeof fetch;
  const deps: ReceiptHostDeps = {
    io: { get: async (k) => secrets.get(k) ?? null, set: async (k, v) => { secrets.set(k, v); } },
    fetchImpl,
    downloadPhoto: async () => new Uint8Array([1, 2, 3]),
    send: async (text, keyboard) => { sent.push({ text, keyboard }); },
    categories: () => CATS,
    spendRows: () => rows,
    spendingAccountIds: () => spending,
    cashAccounts: async () => [
      { id: 'gift-acct', name: 'Gift card cash', currency: 'USD' },
      { id: 'checking', name: 'Checking', currency: 'USD' },
      { id: 'not-spending', name: 'Envelope', currency: 'USD' },
    ],
    feedAccountIds: async () => fed,
    wf: {
      replaceSplits: async (id, lines) => { splits.push({ id, lines }); },
      clearSplits: async (id) => { calls.push(`clear:${id}`); },
      spendingCategoryOf: async () => 'c-gro',
      assign: async (id, cat) => { assigned.push([id, cat]); },
      create: async (writes) => {
        if (refuseCreate) throw new Error('account not in spending scope');
        created.push(...writes);
        return writes.map(() => `new-${++nextId}`);
      },
      remove: async (ids) => { calls.push(`remove:${ids.join(',')}`); },
    },
    log: () => {},
    now: () => now,
    randomId: () => 'p1',
  };
  return {
    deps, host: createReceiptHost(deps), secrets, sent, splits, created, assigned, calls,
    set: (o) => {
      if (o.online !== undefined) online = o.online;
      if (o.transcript !== undefined) transcript = o.transcript;
      if (o.categories) categories = o.categories;
      if (o.rows) rows = o.rows;
      if (o.spending) spending = o.spending;
      if (o.fed) fed = o.fed;
      if (o.refuseCreate !== undefined) refuseCreate = o.refuseCreate;
      if (o.now) now = o.now;
    },
  };
}

function ui() {
  const edits: Array<{ text: string; keyboard?: InlineKeyboard }> = [];
  const answers: Array<string | undefined> = [];
  const u: ReceiptUi = {
    edit: async (text, keyboard) => { edits.push({ text, keyboard }); },
    answer: async (text) => { answers.push(text); },
    send: async () => {},
  };
  return { u, edits, answers };
}

const state = (h: Harness) => parseReceiptState(h.secrets.get(RECEIPT_STATE_SECRET_KEY));
const tap = async (h: Harness, data: string) => {
  const t = ui();
  await h.host.onCallback({ data }, t.u);
  return t;
};

async function proposed(h: Harness) {
  const replies: string[] = [];
  await h.host.onPhoto({ fileId: 'f1', fileUniqueId: 'u1' }, async (t) => { replies.push(t); });
  await h.host.drain();
  return replies;
}

describe('categoryChoices', () => {
  it('keys each category by its path, uniquely', () => {
    const keys = categoryChoices([...CATS, { id: 'dup', name: 'Groceries!', parentId: null }]).map((c) => c.key);
    expect(keys).toEqual(['groceries', 'home', 'home_lamps_lighting', 'groceries_2']);
  });
});

describe('reading a photo', () => {
  it('says how to turn the reader on, and queues nothing, when it is off', async () => {
    const h = harness();
    h.secrets.delete(RECEIPT_CONFIG_SECRET_KEY);
    expect(await proposed(h)).toEqual([RECEIPT_COPY.notSetUp]);
    expect(state(h).queue).toEqual([]);
  });

  it('queues it, reads it, and proposes rows with the tax shared out', async () => {
    const h = harness();
    expect(await proposed(h)).toEqual([RECEIPT_COPY.queued]);
    const s = state(h);
    expect([s.queue.length, s.proposals.length, s.rates]).toEqual([0, 1, [1000]]);
    expect(s.proposals[0].items.map((i) => [i.text, i.cents, i.categoryId])).toEqual([['BREAD', 1000, 'c-gro'], ['LAMP', 11000, 'c-lamps']]);
    expect(h.sent[0].text).toContain('*Home / Lamps & Lighting* — $110.00');
  });

  it('keeps it queued and says so once while the computer is off', async () => {
    const h = harness();
    h.set({ online: false });
    await proposed(h);
    await h.host.drain();
    expect(h.sent.map((m) => m.text)).toEqual([RECEIPT_COPY.offline]);
    expect(state(h).queue).toHaveLength(1);
    h.set({ online: true });
    await h.host.drain();
    expect(state(h).proposals).toHaveLength(1);
  });

  it('says which check failed and drops a receipt that does not add up', async () => {
    const h = harness();
    h.set({ transcript: { ...TILL, total: '125.00' } });
    await proposed(h);
    expect(h.sent[0].text).toMatch(/don't add up/);
    expect([state(h).queue.length, state(h).proposals.length]).toEqual([0, 0]);
  });

  it('leaves items for the person when the category answer is unusable', async () => {
    const h = harness();
    h.set({ categories: ['toys'] });
    await proposed(h);
    expect(state(h).proposals[0].items.every((i) => i.categoryId === NO_CATEGORY)).toBe(true);
    expect((await tap(h, 'cz:rc:ok:p1')).answers).toEqual([RECEIPT_COPY.needsCategory]);
  });

  it('answers a remembered item without asking the model', async () => {
    const h = harness();
    h.secrets.set(RECEIPT_STATE_SECRET_KEY, JSON.stringify({ filings: [{ text: 'bread', categoryId: 'c-home' }, { text: 'LAMP', categoryId: 'c-gro' }] }));
    await proposed(h);
    expect(state(h).proposals[0].items.map((i) => i.categoryId)).toEqual(['c-home', 'c-gro']);
    expect(h.calls.filter((c) => c.endsWith('/api/chat'))).toHaveLength(1);
  });
});

describe('a batch of receipts', () => {
  it('refuses a photo out loud when the queue is full, never dropping one', async () => {
    const h = harness();
    const queue = Array.from({ length: 20 }, (_, n) => ({ fileId: `f${n}`, fileUniqueId: `u${n}`, receivedAt: NOW.toISOString() }));
    h.secrets.set(RECEIPT_STATE_SECRET_KEY, JSON.stringify({ queue }));
    h.set({ online: false });
    const replies: string[] = [];
    await h.host.onPhoto({ fileId: 'new', fileUniqueId: 'new' }, async (t) => { replies.push(t); });
    expect(replies).toEqual([RECEIPT_COPY.queueFull]);
    expect(state(h).queue).toHaveLength(20);
  });

  it('pauses at 10 open proposals and reads on after one is cancelled', async () => {
    const h = harness();
    const open = Array.from({ length: 10 }, (_, n) => ({
      id: `p${n}x`, store: 'S', date: '2027-03-14', createdAt: NOW.toISOString(), items: [], payments: [], taxBasis: 'printed',
    }));
    h.secrets.set(RECEIPT_STATE_SECRET_KEY, JSON.stringify({ proposals: open, queue: [{ fileId: 'f', fileUniqueId: 'u', receivedAt: NOW.toISOString() }] }));
    await h.host.drain();
    expect(h.sent.map((m) => m.text)).toEqual([RECEIPT_COPY.paused]);
    expect(state(h).queue).toHaveLength(1);
    await tap(h, 'cz:rc:x:p0x');
    await h.host.drain();
    expect(state(h).queue).toHaveLength(0);
    expect(state(h).proposals.map((p) => p.id)).toContain('p1');
  });
});

describe('filing', () => {
  it('splits the matching card charge, remembers the items, and offers Undo', async () => {
    const h = harness();
    await proposed(h);
    const t = await tap(h, 'cz:rc:ok:p1');
    expect(h.splits).toEqual([{ id: 'charge-1', lines: [
      { taxonomyId: 'spending_categories', categoryId: 'c-gro', amount: '10.00', note: 'BREAD', sortOrder: 0 },
      { taxonomyId: 'spending_categories', categoryId: 'c-lamps', amount: '110.00', note: 'LAMP', sortOrder: 1 },
    ] }]);
    expect(t.edits[0].text).toContain('Filed');
    expect(t.edits[0].keyboard?.inline_keyboard[0][0].callback_data).toBe('cz:rc:un:p1');
    const s = state(h);
    expect([s.proposals.length, s.filed.length, s.filings.length, s.fingerprints.length]).toEqual([0, 1, 2, 1]);

    const undone = await tap(h, 'cz:rc:un:p1');
    expect(h.calls).toContain('clear:charge-1');
    expect(h.assigned).toEqual([['charge-1', 'c-gro']]);
    expect(undone.edits[0].text).toContain('Undone');
    // What it taught goes too: a corrected resend is not a duplicate, and its items are asked about again.
    const after = state(h);
    expect([after.filed.length, after.filings.length, after.fingerprints.length]).toEqual([0, 0, 0]);
  });

  it('keeps what other receipts taught when one is undone', async () => {
    const h = harness();
    h.secrets.set(RECEIPT_STATE_SECRET_KEY, JSON.stringify({
      filings: [{ text: 'SOAP', categoryId: 'c-home', receiptId: 'older' }],
      fingerprints: [{ key: 'older-key', at: NOW.toISOString() }],
    }));
    await proposed(h);
    await tap(h, 'cz:rc:ok:p1');
    await tap(h, 'cz:rc:un:p1');
    expect([state(h).filings.map((f) => f.text), state(h).fingerprints.map((f) => f.key)]).toEqual([['SOAP'], ['older-key']]);
  });

  it('refuses a receipt paid in cash when it is read, saying why', async () => {
    const h = harness();
    h.set({ transcript: { ...TILL, payments: [{ label: 'CASH', amount: '120.00' }] } });
    await proposed(h);
    expect(h.sent[0].text).toMatch(/one card, gift cards, or both/);
    expect(h.sent[0].text).not.toMatch(/sharper photo/);
    expect(state(h).proposals).toEqual([]);
  });

  it('refuses a stored receipt with two card payments on Confirm, filing nothing', async () => {
    const h = harness();
    await proposed(h);
    const s = state(h);
    s.proposals[0].payments = [{ kind: 'card', label: 'VISA', cents: 5000 }, { kind: 'card', label: 'MASTERCARD', cents: 7000 }];
    h.secrets.set(RECEIPT_STATE_SECRET_KEY, JSON.stringify(s));
    const t = await tap(h, 'cz:rc:ok:p1');
    expect(t.edits[0].text).toMatch(/one card, gift cards, or both/);
    expect([h.splits.length, state(h).filed.length, state(h).proposals.length]).toEqual([0, 0, 1]);
  });

  it('says to add the account in Spending settings when Spending reads no account', async () => {
    const h = harness();
    h.set({ spending: [] });
    await proposed(h);
    const t = await tap(h, 'cz:rc:ok:p1');
    expect(t.edits[0].text).toContain('Spending settings');
    expect([h.splits.length, state(h).waiting.length]).toEqual([0, 0]);
  });

  it('waits for the posted charge rather than splitting a pending one', async () => {
    const h = harness();
    h.set({ rows: [charge({ notes: `CORNER MARKET${PENDING_SUFFIX}` })] });
    await proposed(h);
    const t = await tap(h, 'cz:rc:ok:p1');
    expect(t.edits[0].text).toMatch(/hasn't been imported yet/);
    expect(h.splits).toEqual([]);
    h.set({ rows: [charge({ id: 'posted' })] });
    await h.host.retryWaiting();
    expect(h.splits.map((x) => x.id)).toEqual(['posted']);
  });

  it('moves an item when the person picks another category', async () => {
    const h = harness();
    await proposed(h);
    await tap(h, 'cz:rc:set:p1:0:c-home');
    expect(state(h).proposals[0].items[0].categoryId).toBe('c-home');
  });

  it('asks once which account tracks a gift card, then adds one row there split by category', async () => {
    const h = harness();
    h.set({ transcript: { ...TILL, total: '0.00', payments: [{ label: 'Gift card', amount: '120.00', kind: 'gift_card' }] } });
    await proposed(h);
    const asked = await tap(h, 'cz:rc:ok:p1');
    expect(asked.edits[0].text).toMatch(/Which account tracks/);
    await tap(h, 'cz:rc:ga:p1:gift-acct');
    expect(h.created.map((w) => [w.accountId, w.amount])).toEqual([['gift-acct', 120]]);
    expect(h.splits).toEqual([{ id: 'new-1', lines: [
      expect.objectContaining({ categoryId: 'c-gro', amount: '10.00' }), expect.objectContaining({ categoryId: 'c-lamps', amount: '110.00' }),
    ] }]);
    expect(h.assigned).toEqual([]);
    expect(state(h).giftAccounts).toEqual({ 'corner market': 'gift-acct' });
  });

  it('offers a gift card only Spending accounts no bank feed fills, and says to create one when none does', async () => {
    const h = harness();
    h.set({ transcript: { ...TILL, total: '0.00', payments: [{ label: 'Gift card', amount: '120.00', kind: 'gift_card' }] } });
    await proposed(h);
    const asked = await tap(h, 'cz:rc:ok:p1');
    expect(asked.edits[0].keyboard?.inline_keyboard.map((r) => r[0].text)).toEqual(['Gift card cash', '✕ Cancel']);
    h.set({ fed: ['checking', 'gift-acct'] });
    const none = await tap(h, 'cz:rc:ok:p1');
    expect(none.edits[0].text).toContain('create a cash account');
  });

  it('forgets a remembered gift card account that Wealthfolio refuses, and asks again', async () => {
    const h = harness();
    h.secrets.set(RECEIPT_STATE_SECRET_KEY, JSON.stringify({ giftAccounts: { 'corner market': 'gift-acct' } }));
    h.set({ transcript: { ...TILL, total: '0.00', payments: [{ label: 'Gift card', amount: '120.00', kind: 'gift_card' }] }, refuseCreate: true });
    await proposed(h);
    const refused = await tap(h, 'cz:rc:ok:p1');
    expect(refused.edits[0].text).toMatch(/Wealthfolio refused/);
    expect(state(h).giftAccounts).toEqual({});
    h.set({ refuseCreate: false });
    expect((await tap(h, 'cz:rc:ok:p1')).edits[0].text).toMatch(/Which account tracks/);
  });

  it('asks again for a remembered gift card account that no longer qualifies, and forgets it on Undo', async () => {
    const h = harness();
    h.secrets.set(RECEIPT_STATE_SECRET_KEY, JSON.stringify({ giftAccounts: { 'corner market': 'checking' } }));
    h.set({ transcript: { ...TILL, total: '0.00', payments: [{ label: 'Gift card', amount: '120.00', kind: 'gift_card' }] } });
    await proposed(h);
    expect((await tap(h, 'cz:rc:ok:p1')).edits[0].text).toMatch(/Which account tracks/);
    await tap(h, 'cz:rc:ga:p1:gift-acct');
    expect(state(h).giftAccounts).toEqual({ 'corner market': 'gift-acct' });
    await tap(h, 'cz:rc:un:p1');
    expect(state(h).giftAccounts).toEqual({});
  });

  it('names the remembered gift card account on the next receipt, so a wrong one shows before Confirm', async () => {
    const h = harness();
    h.secrets.set(RECEIPT_STATE_SECRET_KEY, JSON.stringify({ giftAccounts: { 'corner market': 'gift-acct' } }));
    h.set({ transcript: { ...TILL, total: '0.00', payments: [{ label: 'Gift card', amount: '120.00', kind: 'gift_card' }] } });
    await proposed(h);
    expect(h.sent[0].text).toContain('rows in Gift card cash');
  });

  it('asks which charge when two match, and splits the one picked', async () => {
    const h = harness();
    h.set({ rows: [charge(), charge({ id: 'charge-2', accountName: 'Other card' })] });
    await proposed(h);
    const asked = await tap(h, 'cz:rc:ok:p1');
    expect(asked.edits[0].keyboard?.inline_keyboard).toHaveLength(3);
    await tap(h, 'cz:rc:cg:p1:charge-2');
    expect(h.splits.map((x) => x.id)).toEqual(['charge-2']);
  });

  it('waits for a charge not imported yet, and files it after the sync that brings it', async () => {
    const h = harness();
    h.set({ rows: [] });
    await proposed(h);
    const t = await tap(h, 'cz:rc:ok:p1');
    expect(t.edits[0].text).toMatch(/hasn't been imported yet/);
    expect(state(h).waiting).toHaveLength(1);
    await h.host.retryWaiting();
    expect(h.splits).toEqual([]);
    h.set({ rows: [charge()] });
    await h.host.retryWaiting();
    expect(h.splits.map((x) => x.id)).toEqual(['charge-1']);
    expect([state(h).waiting.length, state(h).filed.length]).toEqual([0, 1]);
    expect(h.sent.at(-1)?.text).toContain('Filed');
  });

  it('gives a receipt moved back to the open list a fresh week, so its charge picker still works', async () => {
    const h = harness();
    h.set({ rows: [] });
    await proposed(h);
    // Confirmed on day 6, two charges arrive on day 8: past the 7 days since the photo was read.
    h.set({ now: new Date(NOW.getTime() + 6 * 86_400_000) });
    await tap(h, 'cz:rc:ok:p1');
    h.set({ rows: [charge(), charge({ id: 'charge-2' })], now: new Date(NOW.getTime() + 8 * 86_400_000) });
    await h.host.retryWaiting();
    expect(h.sent.at(-1)?.text).toMatch(/More than one charge/);
    await tap(h, 'cz:rc:cg:p1:charge-2');
    expect(h.splits.map((x) => x.id)).toEqual(['charge-2']);
  });

  it('says a waiting receipt expired even when a tap prunes it before the next sync', async () => {
    const h = harness();
    h.set({ rows: [] });
    await proposed(h);
    await tap(h, 'cz:rc:ok:p1');
    h.set({ now: new Date(NOW.getTime() + 8 * 86_400_000) });
    await tap(h, 'cz:rc:ok:gone');
    await h.host.onPhoto({ fileId: 'f2', fileUniqueId: 'u2' }, async () => {});
    expect(h.sent.filter((m) => /never showed up/.test(m.text))).toHaveLength(1);
    expect(state(h).waiting).toEqual([]);
  });

  it('says a photo expired when a write prunes it, once', async () => {
    const h = harness();
    h.set({ online: false });
    await proposed(h);
    h.set({ now: new Date(NOW.getTime() + 8 * 86_400_000) });
    await h.host.onPhoto({ fileId: 'f2', fileUniqueId: 'u2' }, async () => {});
    await h.host.drain();
    expect(h.sent.filter((m) => m.text === RECEIPT_COPY.expired)).toHaveLength(1);
  });

  it('cancels without filing anything', async () => {
    const h = harness();
    await proposed(h);
    const t = await tap(h, 'cz:rc:x:p1');
    expect(t.edits[0].text).toContain('Cancelled');
    expect([state(h).proposals.length, h.splits.length]).toEqual([0, 0]);
  });

  it('answers a tap on a receipt that is gone', async () => {
    const h = harness();
    expect((await tap(h, 'cz:rc:ok:nope')).answers).toEqual([RECEIPT_COPY.gone]);
  });
});

describe('the host check', () => {
  it('records that the host is ready, then that it went away', async () => {
    const h = harness();
    await h.host.check();
    expect(JSON.parse(h.secrets.get(RECEIPT_STATUS_SECRET_KEY)!)).toEqual({ checkedAt: NOW.toISOString(), error: null });
    h.set({ online: false });
    await h.host.check();
    expect(JSON.parse(h.secrets.get(RECEIPT_STATUS_SECRET_KEY)!).error).toMatch(/Can't reach the model host at http:\/\/mac:11434/);
  });

  it('says when the model is not installed', async () => {
    const h = harness();
    h.secrets.set(RECEIPT_CONFIG_SECRET_KEY, JSON.stringify({ enabled: true, url: 'http://mac:11434', model: 'other:7b' }));
    await h.host.check();
    expect(JSON.parse(h.secrets.get(RECEIPT_STATUS_SECRET_KEY)!).error).toMatch(/other:7b isn't installed/);
  });
});
