import { describe, it, expect } from 'vitest';
import {
  drainHaOutbox, enqueueHa, HA_ADDON_QUEUE_SECRET_KEY, HA_CONFIG_SECRET_KEY, HA_OUTBOX_SECRET_KEY, HA_PENDING_LIMIT,
  HA_RETRY_BASE_MS, HA_RETRY_MAX_MS, haChangedSinceFailure, haConfigComplete, haConfigKey, haDrainMode, haPendingView, haReachProblem,
  haTestEntry, haUrlProblem, homeAssistantConfigForEditing, homeAssistantRequest, mergeDrained, nextHaStatus,
  parseHaOutbox, parseHomeAssistantConfig, plainText, queueHaEntries, queueHaEntriesStrict,
  sendHomeAssistantNotification, syncAlertEntries, syncHealthEntry,
  type HaEntry, type HaOutbox, type HaSecretIo,
} from './home-assistant.js';
import type { SyncResult } from './sync-core.js';

const NOW = new Date('2027-03-15T15:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const IMPORTS_OFF = { notifyOnImport: false, notifyOnImportTrades: true };
const CONFIG = { enabled: true, mode: 'notify' as const, url: 'http://ha.local:8123/', token: 'tok', service: 'notify.mobile_app_phone', titlePrefix: '', linkBase: '', ...IMPORTS_OFF };
const WEBHOOK = { enabled: true, mode: 'webhook' as const, url: 'http://ha.local:8123/api/webhook/abc123', token: '', service: '', titlePrefix: '', linkBase: '', ...IMPORTS_OFF };

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
    expect(homeAssistantConfigForEditing(null)).toEqual({
      enabled: true, mode: 'notify', url: '', token: '', service: '', titlePrefix: '', linkBase: '', ...IMPORTS_OFF,
    });
  });

  it('reads a config stored before the import switches as imports off, trades on', () => {
    const { notifyOnImport: _a, notifyOnImportTrades: _b, ...old } = CONFIG;
    expect(parseHomeAssistantConfig(JSON.stringify(old))).toMatchObject(IMPORTS_OFF);
    expect(homeAssistantConfigForEditing(JSON.stringify(old))).toMatchObject(IMPORTS_OFF);
    expect(parseHomeAssistantConfig(JSON.stringify({ ...CONFIG, notifyOnImport: true, notifyOnImportTrades: false })))
      .toMatchObject({ notifyOnImport: true, notifyOnImportTrades: false });
  });
});

describe('the Home Assistant URL', () => {
  it('takes only http(s) with a host and no credentials', () => {
    expect(haUrlProblem('http://ha.local:8123')).toBeNull();
    expect(haUrlProblem('https://ha.example.com/api/webhook/x')).toBeNull();
    expect(haUrlProblem('ha.local:8123')).toMatch(/http:\/\/ or https:\/\//);
    expect(haUrlProblem('homeassistant.local')).toMatch(/http:\/\/ or https:\/\//);
    expect(haUrlProblem('data:text/plain,hi')).toMatch(/http:\/\/ or https:\/\//);
    expect(haUrlProblem('ftp://ha.local')).toMatch(/http:\/\/ or https:\/\//);
    expect(haUrlProblem('http://user:pw@ha.local:8123')).toMatch(/user name and password/);
    expect(haUrlProblem(' ')).toBe('Enter the address');
  });

  it('makes a config with a bad URL incomplete, so neither half uses it', () => {
    expect(haConfigComplete({ ...WEBHOOK, url: 'data:text/plain,hi' })).toBe(false);
    expect(haConfigComplete({ ...CONFIG, url: 'ha.local:8123' })).toBe(false);
    expect(parseHomeAssistantConfig(JSON.stringify({ ...CONFIG, url: 'http://u:p@ha.local' }))).toBeNull();
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
    }), NOW, nothingKnown, IMPORTS_OFF);
    expect(stuck.id).toBe('stuck:tx-1');
    expect(stuck.title).toMatch(/^⚠️ Transfer stuck/);
    expect(stuck.message).toContain('ONLINE TRANSFER');
    expect(stuck.message).not.toContain('*');
  });

  it('heads a one-line alert with a fallback title', () => {
    const [large] = syncAlertEntries(emptyResult({
      largeTransactionAlerts: [{ txId: 'tx-9', description: 'SOME STORE', amountCents: -98_765, currency: 'USD', accountName: 'Card' }],
    }), NOW, nothingKnown, IMPORTS_OFF);
    expect(large).toMatchObject({ id: 'largetx:tx-9', title: 'Large transaction' });
    expect(large.message).toContain('SOME STORE');
  });

  it('links each alert to the page that shows it: a large transaction to its own story', () => {
    const entries = syncAlertEntries(emptyResult({
      largeTransactionAlerts: [{ txId: 'tx-9', description: 'S', amountCents: -98_765, currency: 'USD', accountName: 'Card', activityId: 'act-9' }],
      stuckTransferAlerts: [{ outTxId: 'tx-1', description: 'T', amountCents: 100, currency: 'USD' }],
      unmappedAccounts: [{ sfinAccountId: 'acct-new', accountName: 'New Card' }],
    }), NOW, nothingKnown, IMPORTS_OFF);
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
    const first = syncAlertEntries(result, NOW, nothingKnown, IMPORTS_OFF);
    expect(first.map((e) => e.id.split(':')[0])).toEqual(['refused', 'unmapped']);
    expect(first[1].message).toContain('New Card (Bank)');
    const known = new Set(first.flatMap((e) => e.keys ?? []));
    expect(syncAlertEntries(result, NOW, (k) => known.has(k), IMPORTS_OFF)).toEqual([]);
  });

  it('says nothing for a run that never read the feed', () => {
    expect(syncAlertEntries(emptyResult({ unmappedAccounts: null }), NOW, nothingKnown, IMPORTS_OFF)).toEqual([]);
  });

  it('sends the import notice only when switched on, without buys and sells when those are off', () => {
    const imported = emptyResult({
      importedTransactions: [
        { sfAccountId: 'a', txId: 't1', description: 'GROCERY', amountCents: -1_200, accountName: 'Card', activityType: 'WITHDRAWAL' },
        { sfAccountId: 'b', txId: 't2', description: 'BUY INDEX FUND', amountCents: -50_000, accountName: 'Brokerage', activityType: 'BUY' },
      ] as SyncResult['importedTransactions'],
    });
    expect(syncAlertEntries(imported, NOW, nothingKnown, IMPORTS_OFF)).toEqual([]);
    const all = syncAlertEntries(imported, NOW, nothingKnown, { notifyOnImport: true, notifyOnImportTrades: true });
    expect(all.map((e) => e.id.split(':')[0])).toEqual(['import']);
    expect(all[0].message).toContain('BUY INDEX FUND');
    const noTrades = syncAlertEntries(imported, NOW, nothingKnown, { notifyOnImport: true, notifyOnImportTrades: false });
    expect(noTrades[0].message).toContain('GROCERY');
    expect(noTrades[0].message).not.toContain('BUY INDEX FUND');
    // Only trades imported, and trades off: nothing to say.
    const onlyTrades = emptyResult({ importedTransactions: [imported.importedTransactions[1]] });
    expect(syncAlertEntries(onlyTrades, NOW, nothingKnown, { notifyOnImport: true, notifyOnImportTrades: false })).toEqual([]);
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

  it('leaves aging out to the drain, which counts what it drops', () => {
    const old = entry('old', at(-8 * DAY));
    const box = enqueueHa({ pending: [old], seen: {} }, [entry('new')], NOW);
    expect(box.pending.map((e) => e.id)).toEqual(['old', 'new']);
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

  it('drops alerts older than a week and beyond the newest 50, counts them, and remembers them', async () => {
    const old = entry('old', at(-8 * DAY), ['old-key']);
    const many = Array.from({ length: HA_PENDING_LIMIT + 2 }, (_, i) => entry(`n${i}`));
    const sent: string[] = [];
    const res = await drainHaOutbox({ pending: [old, ...many], seen: {} }, async (e) => { sent.push(e.id); return { ok: true }; }, NOW);
    expect(res.dropped).toBe(3);
    expect(sent).toHaveLength(HA_PENDING_LIMIT);
    expect(sent[0]).toBe('n2');
    // Remembered, so the add-on's copy of a dropped alert is not counted (or sent) again.
    expect(res.outbox.seen).toHaveProperty('old');
    expect(res.outbox.seen).toHaveProperty('old-key');
  });

  it('ages out, and sends nothing, while delivery waits', async () => {
    const res = await drainHaOutbox({ pending: [entry('old', at(-8 * DAY)), entry('a')], seen: {} }, null, NOW);
    expect(res).toMatchObject({ delivered: 0, dropped: 1, attempted: false });
    expect(res.outbox.pending.map((e) => e.id)).toEqual(['a']);
  });

  it('ages out an alert dated in the future, from a writer whose clock runs fast', async () => {
    const res = await drainHaOutbox({ pending: [entry('skewed', at(DAY * 365))], seen: {} }, null, at(8 * DAY));
    // Read as queued "now" (not next year), it is not yet a week old at +8 days…
    expect(res.dropped).toBe(0);
    // …and the queue's age clamps it rather than keeping it for a year.
    const later = await drainHaOutbox({ pending: [entry('skewed', at(10 * DAY))], seen: {} }, null, at(18 * DAY));
    expect(later.dropped).toBe(1);
  });
});

describe('the add-on queue', () => {
  it('the add-on writes only its own key, and skips what the companion already queued or sent', async () => {
    const io = memoryIo();
    io.data.set(HA_OUTBOX_SECRET_KEY, JSON.stringify({ pending: [entry('companion-queued')], seen: { 'already-sent': NOW.toISOString() } }));
    const before = io.data.get(HA_OUTBOX_SECRET_KEY);
    await queueHaEntries(io, 'addon', () => [entry('companion-queued'), entry('already-sent'), entry('fresh')], NOW);
    expect(io.data.get(HA_OUTBOX_SECRET_KEY)).toBe(before);
    expect(parseHaOutbox(io.data.get(HA_ADDON_QUEUE_SECRET_KEY)).pending.map((e) => e.id)).toEqual(['fresh']);
  });

  it('the add-on forgets what the companion has delivered on its next write', async () => {
    const io = memoryIo();
    io.data.set(HA_ADDON_QUEUE_SECRET_KEY, JSON.stringify({ pending: [entry('a'), entry('b')], seen: {} }));
    io.data.set(HA_OUTBOX_SECRET_KEY, JSON.stringify({ pending: [], seen: { a: NOW.toISOString() } }));
    await queueHaEntries(io, 'addon', () => [entry('c')], NOW);
    expect(parseHaOutbox(io.data.get(HA_ADDON_QUEUE_SECRET_KEY)).pending.map((e) => e.id)).toEqual(['b', 'c']);
  });

  it('the companion does not queue what the add-on already did', async () => {
    const io = memoryIo();
    io.data.set(HA_ADDON_QUEUE_SECRET_KEY, JSON.stringify({ pending: [entry('a')], seen: {} }));
    await queueHaEntries(io, 'companion', () => [entry('a'), entry('b')], NOW);
    expect(parseHaOutbox(io.data.get(HA_OUTBOX_SECRET_KEY)).pending.map((e) => e.id)).toEqual(['b']);
  });

  it('the drain sees both queues once each, oldest first, minus what was delivered', () => {
    const main: HaOutbox = { pending: [entry('c', at(-1_000)), entry('dup', at(-3_000))], seen: { done: NOW.toISOString() } };
    const addon: HaOutbox = { pending: [entry('a', at(-5_000)), entry('dup', at(-3_000)), entry('done')], seen: {} };
    expect(haPendingView(main, addon, NOW).pending.map((e) => e.id)).toEqual(['a', 'dup', 'c']);
  });

  it('the drain leaves out an add-on entry older than its memory of what it sent', () => {
    const addon: HaOutbox = { pending: [entry('ancient', at(-31 * DAY)), entry('old', at(-8 * DAY))], seen: {} };
    expect(haPendingView({ pending: [], seen: {} }, addon, NOW).pending.map((e) => e.id)).toEqual(['old']);
  });

  it('the add-on keeps unsent entries as long as the companion remembers, so a week offline is still counted', async () => {
    const io = memoryIo();
    io.data.set(HA_ADDON_QUEUE_SECRET_KEY, JSON.stringify({
      pending: [entry('ancient', at(-31 * DAY)), entry('week-old', at(-8 * DAY)), entry('fresh', at(-DAY))], seen: {},
    }));
    await queueHaEntries(io, 'addon', () => [entry('new')], NOW);
    expect(parseHaOutbox(io.data.get(HA_ADDON_QUEUE_SECRET_KEY)).pending.map((e) => e.id)).toEqual(['week-old', 'fresh', 'new']);
  });
});

describe('mergeDrained', () => {
  it('saves the new status with what went out, and keeps the old one when there is none', () => {
    const current: HaOutbox = { pending: [entry('a')], seen: {}, status: { lastOkAt: 'old' } };
    const drained: HaOutbox = { pending: [], seen: { a: NOW.toISOString() } };
    expect(mergeDrained(current, drained, NOW, { lastOkAt: 'new' }).status).toEqual({ lastOkAt: 'new' });
    expect(mergeDrained(current, drained, NOW, null).status).toEqual({ lastOkAt: 'old' });
  });

  it('queueing keeps the status and the ids being sent; a recorded pass clears the ids', () => {
    const box = enqueueHa({ pending: [], seen: {}, status: { lastOkAt: 'x' }, sending: ['a'] }, [entry('b')], NOW);
    expect(box.status).toEqual({ lastOkAt: 'x' });
    expect(box.sending).toEqual(['a']);
    expect(mergeDrained(box, { pending: [], seen: {} }, NOW, null).sending).toBeUndefined();
  });

  it('drops what was delivered and keeps what was queued meanwhile', () => {
    const drained: HaOutbox = { pending: [], seen: { a: NOW.toISOString() } };
    const current: HaOutbox = { pending: [entry('a'), entry('late')], seen: {} };
    expect(mergeDrained(current, drained, NOW).pending.map((e) => e.id)).toEqual(['late']);
  });
});

describe('when delivery waits', () => {
  const failedAt = at(-10 * 60_000).toISOString();
  const key = haConfigKey(CONFIG);
  it('a parked failure waits until the config changes', () => {
    const status = { lastError: 'Home Assistant answered 401', lastErrorAt: failedAt, failedFor: key, parked: true as const };
    expect(haDrainMode(status, CONFIG, [entry('a')], NOW)).toBe('wait');
    expect(haDrainMode(status, { ...CONFIG, token: 'new-token' }, [entry('a')], NOW)).not.toBe('wait');
  });

  it('a back-off ends as soon as the config changes', () => {
    const status = { lastError: 'Could not reach Home Assistant (host not found)', lastErrorAt: failedAt, failedFor: key, failures: 6, retryAt: at(4 * 60 * 60_000).toISOString() };
    expect(haDrainMode(status, CONFIG, [entry('a')], NOW)).toBe('wait');
    expect(haDrainMode(status, { ...CONFIG, url: 'http://ha.fixed:8123' }, [entry('a')], NOW)).not.toBe('wait');
  });

  it('a test not tried yet goes through, whatever either clock says', () => {
    const tried = haTestEntry(at(-60 * 60_000));
    const status = { lastError: 'x', lastErrorAt: failedAt, failedFor: key, parked: true as const, triedTests: [tried.id] };
    // A browser clock an hour behind or a day ahead makes no difference: only the id counts.
    expect(haDrainMode(status, CONFIG, [entry('a'), haTestEntry(at(-2 * 60 * 60_000))], NOW)).toBe('tests');
    expect(haDrainMode(status, CONFIG, [entry('a'), haTestEntry(at(DAY))], NOW)).toBe('tests');
    expect(haDrainMode(status, CONFIG, [tried], NOW)).toBe('wait');
  });

  it('a recoverable failure waits for its back-off', () => {
    const status = { lastError: 'x', lastErrorAt: failedAt, failedFor: key, failures: 1, retryAt: at(60_000).toISOString() };
    expect(haDrainMode(status, CONFIG, [entry('a')], NOW)).toBe('wait');
    expect(haDrainMode(status, CONFIG, [entry('a')], at(2 * 60_000))).not.toBe('wait');
    expect(haDrainMode(null, CONFIG, [entry('a')], NOW)).not.toBe('wait');
  });

  it('tells a failure with the saved config from one with an older config', () => {
    const status = { lastError: 'x', lastErrorAt: failedAt, failedFor: key };
    expect(haChangedSinceFailure(status, CONFIG)).toBe(false);
    expect(haChangedSinceFailure(status, { ...CONFIG, service: 'other' })).toBe(true);
    expect(haChangedSinceFailure({ lastOkAt: failedAt }, { ...CONFIG, service: 'other' })).toBe(false);
  });

  it('the config key changes with what delivery depends on, and not with the title prefix', () => {
    expect(haConfigKey(CONFIG)).toBe(haConfigKey({ ...CONFIG }));
    expect(haConfigKey({ ...CONFIG, url: 'http://other:8123' })).not.toBe(haConfigKey(CONFIG));
    expect(haConfigKey({ ...CONFIG, service: 'other' })).not.toBe(haConfigKey(CONFIG));
    expect(haConfigKey(CONFIG)).not.toContain('tok');
  });
});

describe('drainHaOutbox options', () => {
  it('sends only what `only` allows, and leaves the rest pending, untried', async () => {
    const sent: string[] = [];
    const box: HaOutbox = { pending: [entry('failed-before', at(-60_000)), entry('test:x')], seen: {} };
    const res = await drainHaOutbox(box, async (e) => { sent.push(e.id); return { ok: true }; }, NOW, { only: (e) => e.id.startsWith('test:') });
    expect(sent).toEqual(['test:x']);
    expect(res.tried).toEqual(['test:x']);
    expect(res.outbox.pending.map((e) => e.id)).toEqual(['failed-before']);
  });

});

describe('nextHaStatus', () => {
  const sent = { delivered: 1, dropped: 0, attempted: true };
  const key = haConfigKey(CONFIG);
  it('parks a permanent failure on the config it failed with', () => {
    expect(nextHaStatus(null, { ...sent, delivered: 0, error: 'Home Assistant answered 401', permanent: true }, CONFIG, NOW))
      .toEqual({ lastError: 'Home Assistant answered 401', lastErrorAt: NOW.toISOString(), failedFor: key, parked: true });
  });

  it('backs off a recoverable failure, doubling up to 4 hours, and records the config it failed with', () => {
    const fail = { ...sent, delivered: 0, error: 'Home Assistant answered 503' };
    const first = nextHaStatus(null, fail, CONFIG, NOW)!;
    expect(first).toMatchObject({ failures: 1, retryAt: at(HA_RETRY_BASE_MS).toISOString(), failedFor: key });
    const second = nextHaStatus(first, fail, CONFIG, NOW)!;
    expect(second).toMatchObject({ failures: 2, retryAt: at(2 * HA_RETRY_BASE_MS).toISOString() });
    const many = nextHaStatus({ ...first, failures: 20 }, fail, CONFIG, NOW)!;
    expect(many.retryAt).toBe(at(HA_RETRY_MAX_MS).toISOString());
  });

  it('starts the back-off over for a failure with a new config', () => {
    const fail = { ...sent, delivered: 0, error: 'Home Assistant answered 503' };
    const prev = { lastError: 'x', lastErrorAt: failedAtIso(), failedFor: key, failures: 7, retryAt: NOW.toISOString() };
    const other = { ...CONFIG, url: 'http://ha.fixed:8123' };
    expect(nextHaStatus(prev, fail, other, NOW)).toMatchObject({ failures: 1, failedFor: haConfigKey(other) });
  });

  it('remembers which tests it tried, until a delivery or a config change', () => {
    const fail = { ...sent, delivered: 0, error: 'Home Assistant answered 401', permanent: true };
    const first = nextHaStatus(null, { ...fail, tried: ['test:1'] }, CONFIG, NOW)!;
    expect(first.triedTests).toEqual(['test:1']);
    expect(nextHaStatus(first, { ...fail, tried: ['test:2', 'stuck:x'] }, CONFIG, NOW)!.triedTests).toEqual(['test:1', 'test:2']);
    expect(nextHaStatus(first, { ...fail, tried: ['test:2'] }, { ...CONFIG, token: 'new' }, NOW)!.triedTests).toEqual(['test:2']);
    expect(nextHaStatus(first, { ...sent, tried: ['test:2'] }, CONFIG, NOW)).toEqual({ lastOkAt: NOW.toISOString() });
  });

  it('keeps every tried test still waiting, however many', () => {
    const fail = { ...sent, delivered: 0, error: 'Home Assistant answered 401', permanent: true };
    const ids = Array.from({ length: 30 }, (_, i) => `test:${i}`);
    let status = null as ReturnType<typeof nextHaStatus>;
    for (const id of ids) {
      status = nextHaStatus(status, { ...fail, tried: [id], outbox: { pending: ids.map((x) => entry(x)), seen: {} } }, CONFIG, NOW);
    }
    expect(status!.triedTests).toEqual(ids);
    // One no longer waiting drops out.
    const after = nextHaStatus(status, { ...fail, tried: [], outbox: { pending: ids.slice(1).map((x) => entry(x)), seen: {} } }, CONFIG, NOW);
    expect(after!.triedTests).toEqual(ids.slice(1));
  });

  it('a test that only times out through a park leaves the park in place', () => {
    const parked = { lastError: 'Home Assistant answered 403', lastErrorAt: failedAtIso(), failedFor: key, parked: true as const };
    const timedOut = nextHaStatus(parked, { ...sent, delivered: 0, error: 'Could not reach Home Assistant (timed out)', tried: ['test:1'] }, CONFIG, NOW)!;
    expect(timedOut.parked).toBe(true);
    expect(haDrainMode(timedOut, CONFIG, [entry('a')], at(10 * 60_000))).toBe('wait');
  });

  it('a success clears the error, the park and the back-off', () => {
    const prev = { lastError: 'x', lastErrorAt: failedAtIso(), failures: 3, retryAt: NOW.toISOString(), failedFor: 'k', parked: true as const };
    expect(nextHaStatus(prev, sent, CONFIG, NOW)).toEqual({ lastOkAt: NOW.toISOString() });
  });

  it('changes nothing when nothing was sent or dropped, so an idle pass never says Connected', () => {
    const prev = { lastError: 'x', lastErrorAt: failedAtIso() };
    expect(nextHaStatus(prev, { delivered: 0, dropped: 0, attempted: false }, CONFIG, NOW)).toBeNull();
  });

  it('records alerts dropped unsent, and keeps the error that explains them', () => {
    const prev = { lastError: 'Home Assistant answered 401', lastErrorAt: failedAtIso(), failedFor: 'k', parked: true as const, dropped: 2, droppedAt: failedAtIso() };
    expect(nextHaStatus(prev, { delivered: 0, dropped: 3, attempted: false }, CONFIG, NOW)).toEqual({
      lastError: 'Home Assistant answered 401', lastErrorAt: failedAtIso(), failedFor: 'k', parked: true, dropped: 5, droppedAt: NOW.toISOString(),
    });
  });

  it('counts alerts treated as sent without knowing they arrived, and keeps the error', () => {
    const prev = { lastError: 'x', lastErrorAt: failedAtIso(), failedFor: 'k', parked: true as const };
    expect(nextHaStatus(prev, { delivered: 0, dropped: 0, unsure: 2, attempted: false }, CONFIG, NOW)).toEqual({
      ...prev, unsure: 2, unsureAt: NOW.toISOString(),
    });
    const old = { unsure: 9, unsureAt: at(-8 * DAY).toISOString() };
    expect(nextHaStatus(old, { delivered: 0, dropped: 0, unsure: 1, attempted: false }, CONFIG, NOW)).toMatchObject({ unsure: 1 });
  });

  it('starts the dropped count over once the last drop is more than a week old', () => {
    const prev = { lastOkAt: failedAtIso(), dropped: 40, droppedAt: at(-8 * DAY).toISOString() };
    expect(nextHaStatus(prev, { delivered: 0, dropped: 2, attempted: false }, CONFIG, NOW)).toMatchObject({ dropped: 2, droppedAt: NOW.toISOString() });
  });
});

function failedAtIso(): string {
  return at(-10 * 60_000).toISOString();
}

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

  it('points a webhook miss at the URL, and calls it permanent', async () => {
    const missing = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    expect(await sendHomeAssistantNotification(WEBHOOK, entry('a'), missing))
      .toEqual({ ok: false, permanent: true, description: 'Home Assistant answered 404 (check the webhook URL)' });
  });

  it('calls a rejected token or a wrong service permanent, and a server error not', async () => {
    const answering = (status: number) => (async () => new Response('', { status })) as unknown as typeof fetch;
    expect(await sendHomeAssistantNotification(CONFIG, entry('a'), answering(401)))
      .toEqual({ ok: false, permanent: true, description: 'Home Assistant answered 401 (check the access token)' });
    expect(await sendHomeAssistantNotification(CONFIG, entry('a'), answering(403))).toMatchObject({ permanent: true });
    expect(await sendHomeAssistantNotification(CONFIG, entry('a'), answering(400)))
      .toMatchObject({ permanent: true, description: 'Home Assistant answered 400 (check the notify service name)' });
    expect(await sendHomeAssistantNotification(WEBHOOK, entry('a'), answering(405))).toMatchObject({ permanent: true });
    expect(await sendHomeAssistantNotification(CONFIG, entry('a'), answering(503)))
      .toEqual({ ok: false, description: 'Home Assistant answered 503' });
  });

  it('never follows a redirect, and names only where it pointed', async () => {
    let init: RequestInit | undefined;
    const redirecting = (async (_u: string, i: RequestInit) => {
      init = i;
      return new Response(null, { status: 301, headers: { location: 'https://ha.example.com/api/webhook/abc123' } });
    }) as unknown as typeof fetch;
    const res = await sendHomeAssistantNotification(WEBHOOK, entry('a'), redirecting);
    expect(init?.redirect).toBe('manual');
    expect(res).toEqual({ ok: false, permanent: true, description: 'Home Assistant redirected to https://ha.example.com; use that address' });
    expect(res.description).not.toContain('abc123');
    const noLocation = (async () => new Response(null, { status: 302 })) as unknown as typeof fetch;
    expect((await sendHomeAssistantNotification(WEBHOOK, entry('a'), noLocation)).description)
      .toBe('Home Assistant answered with a redirect; check the address');
  });

  it('describes an unreachable host by the kind of error, never by fetch\'s message', async () => {
    const failing = (cause: object) => (async () => {
      throw Object.assign(new TypeError('fetch failed to http://secret-webhook-id@ha.local'), { cause });
    }) as unknown as typeof fetch;
    const res = await sendHomeAssistantNotification(CONFIG, entry('a'), failing({ code: 'ECONNREFUSED' }));
    expect(res).toEqual({ ok: false, description: 'Could not reach Home Assistant (connection refused)' });
    expect(res.description).not.toContain('secret');
    expect(haReachProblem(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timed out');
    expect(haReachProblem({ cause: { code: 'ENOTFOUND' } })).toBe('host not found');
    expect(haReachProblem({ cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } })).toBe('certificate problem');
    expect(haReachProblem({ cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } })).toBe('certificate problem');
    expect(haReachProblem(new Error('anything at all'))).toBe('network error');
  });

  it('releases the connection after reading the status', async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel: () => { cancelled = true; } });
    const ok = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    expect(await sendHomeAssistantNotification(CONFIG, entry('a'), ok)).toEqual({ ok: true });
    expect(cancelled).toBe(true);
  });
});

describe('queueHaEntries', () => {
  it('writes nothing when Home Assistant is not set up', async () => {
    const io = memoryIo(false);
    await queueHaEntries(io, 'addon', () => [entry('a')], NOW);
    await queueHaEntries(io, 'companion', () => [entry('a')], NOW);
    expect(io.writes).toBe(0);
  });

  it('queues once, and a second identical raise writes nothing', async () => {
    for (const [writer, key] of [['addon', HA_ADDON_QUEUE_SECRET_KEY], ['companion', HA_OUTBOX_SECRET_KEY]] as const) {
      const io = memoryIo();
      await queueHaEntries(io, writer, () => [haTestEntry(NOW)], NOW);
      await queueHaEntries(io, writer, () => [haTestEntry(NOW)], NOW);
      expect(io.writes).toBe(1);
      expect(parseHaOutbox(io.data.get(key)).pending).toHaveLength(1);
    }
  });

  it('hands the builder the config, for its import switches', async () => {
    const io = memoryIo();
    let seen: unknown;
    await queueHaEntries(io, 'addon', (_k, config) => { seen = config; return []; }, NOW);
    expect(seen).toMatchObject({ notifyOnImport: false, url: CONFIG.url });
  });

  it('never throws', async () => {
    const broken: HaSecretIo = { get: async () => { throw new Error('locked'); }, set: async () => {} };
    await expect(queueHaEntries(broken, 'addon', () => [entry('a')], NOW)).resolves.toBeUndefined();
  });
});

describe('queueHaEntriesStrict (Send a test)', () => {
  it('says when Home Assistant is off, and queues nothing', async () => {
    const io = memoryIo();
    io.data.set(HA_CONFIG_SECRET_KEY, JSON.stringify({ ...CONFIG, enabled: false }));
    expect(await queueHaEntriesStrict(io, 'addon', () => [haTestEntry(NOW)], NOW)).toBe('off');
    expect(io.writes).toBe(0);
  });

  it('rejects when the secrets cannot be read or written', async () => {
    const unreadable: HaSecretIo = { get: async () => { throw new Error('locked'); }, set: async () => {} };
    await expect(queueHaEntriesStrict(unreadable, 'addon', () => [haTestEntry(NOW)], NOW)).rejects.toThrow('locked');
    const io = memoryIo();
    const unwritable: HaSecretIo = { get: io.get, set: async () => { throw new Error('read-only'); } };
    await expect(queueHaEntriesStrict(unwritable, 'addon', () => [haTestEntry(NOW)], NOW)).rejects.toThrow('read-only');
  });

  it('resolves queued when it queued', async () => {
    expect(await queueHaEntriesStrict(memoryIo(), 'addon', () => [haTestEntry(NOW)], NOW)).toBe('queued');
  });
});
