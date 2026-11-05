import { describe, it, expect } from 'vitest';
import {
  drainHaOutbox, enqueueHa, HA_CONFIG_SECRET_KEY, HA_OUTBOX_SECRET_KEY, HA_PENDING_LIMIT, haTestEntry,
  homeAssistantConfigForEditing, homeAssistantRequest, mergeDrained, parseHaOutbox, parseHomeAssistantConfig, plainText,
  queueHaEntries, sendHomeAssistantNotification, syncAlertEntries, syncHealthEntry,
  type HaEntry, type HaOutbox, type HaSecretIo,
} from './home-assistant.js';
import type { SyncResult } from './sync-core.js';

const NOW = new Date('2027-03-15T15:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const CONFIG = { enabled: true, mode: 'notify' as const, url: 'http://ha.local:8123/', token: 'tok', service: 'notify.mobile_app_phone', titlePrefix: '', linkBase: '' };
const WEBHOOK = { enabled: true, mode: 'webhook' as const, url: 'http://ha.local:8123/api/webhook/abc123', token: '', service: '', titlePrefix: '', linkBase: '' };

const emptyResult = (over: Partial<SyncResult> = {}): SyncResult => ({
  imported: 0, skipped: 0, errors: [], stuckTransferAlerts: [], importedTransactions: [], largeTransactionAlerts: [],
  balanceDriftAlerts: [], prunedDuplicates: [], unmappedAccounts: null, refusedCreates: [],
  holdingsSnapshots: { imported: 0, skipped: 0, unresolvedSymbols: [] },
  ...over,
});
const nothingKnown = () => false;
const entry = (id: string, createdAt = NOW, keys?: string[]): HaEntry =>
  ({ id, title: id, message: 'm', createdAt: createdAt.toISOString(), ...(keys ? { keys } : {}) });

/** An in-memory secret store with a Home Assistant config. */
function memoryIo(configured = true): HaSecretIo & { data: Map<string, string>; writes: number } {
  const data = new Map<string, string>();
  if (configured) data.set(HA_CONFIG_SECRET_KEY, JSON.stringify(CONFIG));
  const io = {
    data, writes: 0,
    get: async (k: string) => data.get(k) ?? null,
    set: async (k: string, v: string) => { io.writes++; data.set(k, v); },
  };
  return io;
}

describe('the config', () => {
  it('counts only a complete, switched-on config as set up', () => {
    expect(parseHomeAssistantConfig(JSON.stringify(CONFIG))).toMatchObject({ url: CONFIG.url, service: CONFIG.service });
    expect(parseHomeAssistantConfig(JSON.stringify({ ...CONFIG, enabled: false }))).toBeNull();
    expect(parseHomeAssistantConfig(JSON.stringify({ ...CONFIG, token: ' ' }))).toBeNull();
    expect(parseHomeAssistantConfig('not json')).toBeNull();
    expect(parseHomeAssistantConfig(null)).toBeNull();
  });

  it('reads a config stored before webhooks existed as the notify service', () => {
    const { mode: _mode, ...old } = CONFIG;
    expect(parseHomeAssistantConfig(JSON.stringify(old))?.mode).toBe('notify');
    expect(homeAssistantConfigForEditing(JSON.stringify(old)).mode).toBe('notify');
  });

  it('needs only the URL for a webhook', () => {
    expect(parseHomeAssistantConfig(JSON.stringify(WEBHOOK))).toMatchObject({ mode: 'webhook', url: WEBHOOK.url });
    expect(parseHomeAssistantConfig(JSON.stringify({ ...WEBHOOK, url: ' ' }))).toBeNull();
  });

  it('keeps a switched-off config for editing', () => {
    expect(homeAssistantConfigForEditing(JSON.stringify({ ...CONFIG, enabled: false }))).toMatchObject({ enabled: false, token: 'tok' });
    expect(homeAssistantConfigForEditing(null)).toEqual({ enabled: true, mode: 'notify', url: '', token: '', service: '', titlePrefix: '', linkBase: '' });
  });
});

describe('plainText', () => {
  it('drops Markdown emphasis but keeps escaped characters and emoji', () => {
    expect(plainText('⚠️ *Transfer stuck*\nACME\\_PAY \\*1')).toBe('⚠️ Transfer stuck\nACME_PAY *1');
    expect(plainText('_…and 3 more._')).toBe('…and 3 more.');
  });
});

describe('syncAlertEntries', () => {
  it('turns each alert into a title and a message, the title from the alert\'s first line', () => {
    const [stuck] = syncAlertEntries(emptyResult({
      stuckTransferAlerts: [{ outTxId: 'tx-1', description: 'ONLINE TRANSFER', amountCents: 12_345, currency: 'USD' }],
    }), NOW, nothingKnown);
    expect(stuck.id).toBe('stuck:tx-1');
    expect(stuck.title).toMatch(/^⚠️ Transfer stuck/);
    expect(stuck.message).toContain('ONLINE TRANSFER');
    expect(stuck.message).not.toContain('*');
  });

  it('heads a one-line alert with a fallback title', () => {
    const [large] = syncAlertEntries(emptyResult({
      largeTransactionAlerts: [{ txId: 'tx-9', description: 'SOME STORE', amountCents: -98_765, currency: 'USD', accountName: 'Card' }],
    }), NOW, nothingKnown);
    expect(large).toMatchObject({ id: 'largetx:tx-9', title: 'Large transaction' });
    expect(large.message).toContain('SOME STORE');
  });

  it('links each alert to the page that shows it: a large transaction to its own story', () => {
    const entries = syncAlertEntries(emptyResult({
      largeTransactionAlerts: [{ txId: 'tx-9', description: 'S', amountCents: -98_765, currency: 'USD', accountName: 'Card', activityId: 'act-9' }],
      stuckTransferAlerts: [{ outTxId: 'tx-1', description: 'T', amountCents: 100, currency: 'USD' }],
      unmappedAccounts: [{ sfinAccountId: 'acct-new', accountName: 'New Card' }],
    }), NOW, nothingKnown);
    const byKind = Object.fromEntries(entries.map((e) => [e.id.split(':')[0], e.link]));
    expect(byKind.largetx).toBe('/addons/simplefin-sync?tab=home&story=act-9');
    expect(byKind.stuck).toBe('/addons/simplefin-sync?tab=home');
    expect(byKind.unmapped).toBe('/addons/simplefin-sync?tab=settings');
  });

  it('queues a re-reported refusal or unmapped account only once', () => {
    const refused = { txId: 'r1', description: 'X', amountCents: 100, currency: 'USD', accountName: 'Card', date: '2027-03-14' };
    const result = emptyResult({
      refusedCreates: [refused],
      unmappedAccounts: [{ sfinAccountId: 'acct-new', accountName: 'New Card', orgName: 'Bank' }],
    });
    const first = syncAlertEntries(result, NOW, nothingKnown);
    expect(first.map((e) => e.id.split(':')[0])).toEqual(['refused', 'unmapped']);
    expect(first[1].message).toContain('New Card (Bank)');
    const known = new Set(first.flatMap((e) => e.keys ?? []));
    expect(syncAlertEntries(result, NOW, (k) => known.has(k))).toEqual([]);
  });

  it('says nothing for a run that never read the feed', () => {
    expect(syncAlertEntries(emptyResult({ unmappedAccounts: null }), NOW, nothingKnown)).toEqual([]);
  });

  it('names the sync-failing alert after its streak', () => {
    expect(syncHealthEntry('2027-03-14T10:00:00.000Z', 'HTTP 403', NOW)).toMatchObject({
      id: 'synchealth:2027-03-14T10:00:00.000Z', title: 'SimpleFin sync failing',
    });
  });
});

describe('the outbox', () => {
  it('queues an alert once, however many times it is raised', () => {
    let box: HaOutbox = { pending: [], seen: {} };
    box = enqueueHa(box, [entry('a')], NOW);
    box = enqueueHa(box, [entry('a'), entry('b')], NOW);
    expect(box.pending.map((e) => e.id)).toEqual(['a', 'b']);
    box = enqueueHa({ pending: [], seen: { a: NOW.toISOString() } }, [entry('a')], NOW);
    expect(box.pending).toEqual([]);
  });

  it('drops alerts older than a week and keeps the newest 50', () => {
    const old = entry('old', at(-8 * DAY));
    const many = Array.from({ length: HA_PENDING_LIMIT + 5 }, (_, i) => entry(`n${i}`));
    const box = enqueueHa({ pending: [old], seen: {} }, many, NOW);
    expect(box.pending).toHaveLength(HA_PENDING_LIMIT);
    expect(box.pending.some((e) => e.id === 'old')).toBe(false);
    expect(box.pending.at(-1)?.id).toBe(`n${HA_PENDING_LIMIT + 4}`);
  });

  it('forgets delivered keys after 30 days', () => {
    const box = enqueueHa({ pending: [], seen: { gone: at(-31 * DAY).toISOString(), kept: at(-2 * DAY).toISOString() } }, [], NOW);
    expect(Object.keys(box.seen)).toEqual(['kept']);
  });

  it('reads a damaged outbox as empty', () => {
    expect(parseHaOutbox('{"pending":[{"id":1}],"seen":[]}')).toEqual({ pending: [], seen: {} });
  });
});

describe('drainHaOutbox', () => {
  it('sends oldest first, remembers what went out, and stops at the first failure', async () => {
    const sent: string[] = [];
    const box: HaOutbox = { pending: [entry('a', NOW, ['k1']), entry('b'), entry('c')], seen: {} };
    const res = await drainHaOutbox(box, async (e) => {
      sent.push(e.id);
      return e.id === 'b' ? { ok: false, description: 'down' } : { ok: true };
    }, NOW);
    expect(sent).toEqual(['a', 'b']);
    expect(res).toMatchObject({ delivered: 1, error: 'down' });
    expect(res.outbox.pending.map((e) => e.id)).toEqual(['b', 'c']);
    expect(Object.keys(res.outbox.seen).sort()).toEqual(['a', 'k1']);
  });
});

describe('mergeDrained', () => {
  it('drops what was delivered and keeps what was queued meanwhile', () => {
    const drained: HaOutbox = { pending: [], seen: { a: NOW.toISOString() } };
    const current: HaOutbox = { pending: [entry('a'), entry('late')], seen: {} };
    expect(mergeDrained(current, drained, NOW).pending.map((e) => e.id)).toEqual(['late']);
  });
});

describe('the request to Home Assistant', () => {
  it('posts the title and message to the notify service', () => {
    const { url, init } = homeAssistantRequest(CONFIG, entry('a'));
    expect(url).toBe('http://ha.local:8123/api/services/notify/mobile_app_phone');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(JSON.parse(String(init.body))).toEqual({ title: 'a', message: 'm' });
  });

  it('posts the title, message and what the alert is about to a webhook, with no token', () => {
    const { url, init } = homeAssistantRequest(WEBHOOK, { ...entry('a'), id: 'largetx:TRN-1' });
    expect(url).toBe(WEBHOOK.url);
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(String(init.body))).toEqual({
      title: 'a', message: 'm', source: 'simplefin-sync', kind: 'large_transaction', id: 'largetx:TRN-1',
    });
  });

  it('puts the title prefix in front of every title', () => {
    const { init } = homeAssistantRequest({ ...WEBHOOK, titlePrefix: ' [Wealth] ' }, entry('Large transaction'));
    expect(JSON.parse(String(init.body)).title).toBe('[Wealth] Large transaction');
  });

  it('sends a tap link only with an address and a page', () => {
    const linked = { ...entry('a'), link: '/addons/simplefin-sync?tab=home' };
    const withBase = { ...WEBHOOK, linkBase: 'https://wf.example.com/' };
    expect(JSON.parse(String(homeAssistantRequest(withBase, linked).init.body)).url)
      .toBe('https://wf.example.com/addons/simplefin-sync?tab=home');
    expect(JSON.parse(String(homeAssistantRequest(WEBHOOK, linked).init.body))).not.toHaveProperty('url');
    expect(JSON.parse(String(homeAssistantRequest(withBase, entry('a')).init.body))).not.toHaveProperty('url');
    expect(JSON.parse(String(homeAssistantRequest({ ...withBase, linkBase: 'wf.example.com' }, linked).init.body)))
      .not.toHaveProperty('url');
    // The notify service hands it to the companion app, for both phone platforms.
    expect(JSON.parse(String(homeAssistantRequest({ ...CONFIG, linkBase: 'https://wf.example.com' }, linked).init.body)).data)
      .toEqual({ url: 'https://wf.example.com/addons/simplefin-sync?tab=home', clickAction: 'https://wf.example.com/addons/simplefin-sync?tab=home' });
  });

  it('points a webhook miss at the URL', async () => {
    const missing = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    expect(await sendHomeAssistantNotification(WEBHOOK, entry('a'), missing))
      .toEqual({ ok: false, description: 'Home Assistant answered 404 (check the webhook URL)' });
  });

  it('explains a rejected token and an unreachable host', async () => {
    const unauthorized = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    expect(await sendHomeAssistantNotification(CONFIG, entry('a'), unauthorized))
      .toEqual({ ok: false, description: 'Home Assistant answered 401 (check the access token)' });
    const offline = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect((await sendHomeAssistantNotification(CONFIG, entry('a'), offline)).description).toMatch(/Could not reach/);
  });
});

describe('queueHaEntries', () => {
  it('writes nothing when Home Assistant is not set up', async () => {
    const io = memoryIo(false);
    await queueHaEntries(io, () => [entry('a')], NOW);
    expect(io.writes).toBe(0);
  });

  it('queues once, and a second identical raise writes nothing', async () => {
    const io = memoryIo();
    await queueHaEntries(io, () => [haTestEntry(NOW)], NOW);
    await queueHaEntries(io, () => [haTestEntry(NOW)], NOW);
    expect(io.writes).toBe(1);
    expect(parseHaOutbox(io.data.get(HA_OUTBOX_SECRET_KEY)).pending).toHaveLength(1);
  });

  it('never throws', async () => {
    const broken: HaSecretIo = { get: async () => { throw new Error('locked'); }, set: async () => {} };
    await expect(queueHaEntries(broken, () => [entry('a')], NOW)).resolves.toBeUndefined();
  });
});
