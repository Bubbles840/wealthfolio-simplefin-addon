import { beforeEach, describe, it, expect } from 'vitest';
import {
  drainHomeAssistant, haDrainDue, haKnownSetUp, HA_IDLE_RECHECK_MS, queueSyncHealthForHomeAssistant, resetHaDrainMemory,
} from './home-assistant-host.js';
import {
  HA_ADDON_QUEUE_SECRET_KEY, HA_CONFIG_SECRET_KEY, HA_OUTBOX_SECRET_KEY, HA_STATUS_SECRET_KEY, haConfigKey, haTestEntry,
  parseHaOutbox, queueHaEntries, type HaEntry, type HaSecretIo,
} from '../../shared/home-assistant.js';

const NOW = new Date('2027-03-15T15:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const DAY = 24 * 60 * 60 * 1000;
const CONFIG = {
  enabled: true, mode: 'notify' as const, url: 'http://ha.local:8123', token: 'tok', service: 'mobile_app_phone',
  titlePrefix: '', linkBase: '', notifyOnImport: false, notifyOnImportTrades: true,
};

function memoryIo(configured = true): HaSecretIo & { data: Map<string, string> } {
  const data = new Map<string, string>(configured ? [[HA_CONFIG_SECRET_KEY, JSON.stringify(CONFIG)]] : []);
  return { data, get: async (k) => data.get(k) ?? null, set: async (k, v) => { data.set(k, v); } };
}
const answering = (status: number) => (async () => new Response('', { status })) as unknown as typeof fetch;
function counting(status: number): { fetch: typeof fetch; calls: () => number } {
  let n = 0;
  return { fetch: (async () => { n++; return new Response('', { status }); }) as unknown as typeof fetch, calls: () => n };
}
const statusOf = (io: { data: Map<string, string> }) => JSON.parse(io.data.get(HA_STATUS_SECRET_KEY) ?? 'null');
const entry = (id: string, createdAt = NOW): HaEntry => ({ id, title: id, message: 'm', createdAt: createdAt.toISOString() });

beforeEach(() => resetHaDrainMemory());

describe('drainHomeAssistant', () => {
  it('sends what is queued, empties the outbox and records when it last worked', async () => {
    const io = memoryIo();
    await queueHaEntries(io, 'companion', () => [haTestEntry(NOW)], NOW);
    expect(await drainHomeAssistant(io, answering(200), NOW)).toBe(1);
    expect(parseHaOutbox(io.data.get(HA_OUTBOX_SECRET_KEY)).pending).toEqual([]);
    expect(statusOf(io)).toEqual({ lastOkAt: NOW.toISOString() });
  });

  it('sends what the add-on queued, without writing the add-on\'s key', async () => {
    const io = memoryIo();
    await queueHaEntries(io, 'addon', () => [entry('from-addon')], NOW);
    const addonQueue = io.data.get(HA_ADDON_QUEUE_SECRET_KEY);
    const c = counting(200);
    expect(await drainHomeAssistant(io, c.fetch, NOW)).toBe(1);
    expect(io.data.get(HA_ADDON_QUEUE_SECRET_KEY)).toBe(addonQueue);
    // Delivered: in `seen`, so the next drain does not send it again.
    expect(await drainHomeAssistant(io, c.fetch, at(60_000))).toBe(0);
    expect(c.calls()).toBe(1);
  });

  it('parks after a rejected token: no more requests until the config changes', async () => {
    const io = memoryIo();
    await queueHaEntries(io, 'companion', () => [entry('a')], NOW);
    const c = counting(401);
    expect(await drainHomeAssistant(io, c.fetch, NOW)).toBe(0);
    expect(statusOf(io)).toMatchObject({
      lastError: 'Home Assistant answered 401 (check the access token)', failedFor: haConfigKey(CONFIG), parked: true,
    });
    // Every 5 minutes for half a day: not one more failed login.
    for (let i = 1; i <= 144; i++) await drainHomeAssistant(io, c.fetch, at(i * 5 * 60_000));
    expect(c.calls()).toBe(1);
    // A new token is tried at once.
    io.data.set(HA_CONFIG_SECRET_KEY, JSON.stringify({ ...CONFIG, token: 'new' }));
    await drainHomeAssistant(io, c.fetch, at(DAY / 2 + 60_000));
    expect(c.calls()).toBe(2);
  });

  it('tries a test sent while parked, so the card shows whether a fix on Home Assistant\'s side worked', async () => {
    const io = memoryIo();
    await queueHaEntries(io, 'companion', () => [entry('a')], NOW);
    await drainHomeAssistant(io, answering(401), NOW);
    await queueHaEntries(io, 'addon', () => [haTestEntry(at(60_000))], at(60_000));
    // Only the test goes through the park; the held alert follows on the next pass.
    expect(await drainHomeAssistant(io, answering(200), at(2 * 60_000))).toBe(1);
    expect(statusOf(io)).toEqual({ lastOkAt: at(2 * 60_000).toISOString() });
  });

  it('backs off while Home Assistant is down, instead of trying every 5 minutes', async () => {
    const io = memoryIo();
    await queueHaEntries(io, 'companion', () => [entry('a')], NOW);
    const c = counting(503);
    for (let i = 0; i < 288; i++) await drainHomeAssistant(io, c.fetch, at(i * 5 * 60_000));
    // Waits of 5, 10, 20, 40, 80, 160 minutes, then 4 hours: tries at minutes 0, 5, 15,
    // 35, 75, 155, 315, 555, 795, 1035 and 1275. 11 in a day, not 288.
    expect(c.calls()).toBe(11);
    expect(statusOf(io)).toMatchObject({ lastError: 'Home Assistant answered 503', failures: 11 });
  });

  it('a fixed address is tried at once, not after the back-off', async () => {
    const io = memoryIo();
    await queueHaEntries(io, 'companion', () => [entry('a')], NOW);
    const down = counting(503);
    for (let i = 0; i < 100; i++) await drainHomeAssistant(io, down.fetch, at(i * 5 * 60_000));
    expect(statusOf(io).retryAt > at(100 * 5 * 60_000).toISOString()).toBe(true);
    io.data.set(HA_CONFIG_SECRET_KEY, JSON.stringify({ ...CONFIG, url: 'http://ha.fixed:8123' }));
    expect(await drainHomeAssistant(io, answering(200), at(100 * 5 * 60_000))).toBe(1);
  });

  it('a delivered add-on alert stays delivered after the companion forgets it, with nothing counted dropped', async () => {
    const io = memoryIo();
    await queueHaEntries(io, 'addon', () => [entry('from-addon')], NOW);
    expect(await drainHomeAssistant(io, answering(200), NOW)).toBe(1);
    // 31 days with only the companion queueing: its memory of the add-on alert expires.
    const later = at(31 * DAY);
    await queueHaEntries(io, 'companion', () => [entry('companion-alert', later)], later);
    await drainHomeAssistant(io, answering(200), later);
    const before = statusOf(io);
    const sent = counting(200);
    await drainHomeAssistant(io, sent.fetch, at(31 * DAY + 5 * 60_000));
    await drainHomeAssistant(io, sent.fetch, at(31 * DAY + 10 * 60_000));
    expect(statusOf(io)).toEqual(before);
    expect(before.dropped).toBeUndefined();
    expect(sent.calls()).toBe(0);
  });

  it('a test pressed while the token is still bad is tried once, and the failed alert not at all', async () => {
    const io = memoryIo();
    await queueHaEntries(io, 'companion', () => [entry('a')], NOW);
    const bad = counting(401);
    await drainHomeAssistant(io, bad.fetch, NOW);
    await queueHaEntries(io, 'addon', () => [haTestEntry(at(60_000))], at(60_000));
    // A week of 5-minute passes: one request, for the test.
    for (let i = 1; i <= 2016; i++) await drainHomeAssistant(io, bad.fetch, at(60_000 + i * 5 * 60_000));
    expect(bad.calls()).toBe(2);
  });

  it('a test that gets through clears the park, and the held alert goes out next', async () => {
    const io = memoryIo();
    await queueHaEntries(io, 'companion', () => [entry('a')], NOW);
    await drainHomeAssistant(io, answering(401), NOW);
    await queueHaEntries(io, 'addon', () => [haTestEntry(at(60_000))], at(60_000));
    const ok = counting(200);
    expect(await drainHomeAssistant(io, ok.fetch, at(2 * 60_000))).toBe(1);
    expect(statusOf(io)).toEqual({ lastOkAt: at(2 * 60_000).toISOString() });
    expect(await drainHomeAssistant(io, ok.fetch, at(7 * 60_000))).toBe(1);
    expect(ok.calls()).toBe(2);
  });

  it('sends nothing when the status cannot be read', async () => {
    const io = memoryIo();
    await queueHaEntries(io, 'companion', () => [entry('a')], NOW);
    await drainHomeAssistant(io, answering(401), NOW);
    const c = counting(401);
    const flaky: HaSecretIo = { get: async (k) => { if (k === HA_STATUS_SECRET_KEY) throw new Error('503'); return io.get(k); }, set: io.set };
    await expect(drainHomeAssistant(flaky, c.fetch, at(5 * 60_000))).rejects.toThrow('503');
    expect(c.calls()).toBe(0);
  });

  it('never writes an older copy of the outbox when the re-read fails, and never sends twice', async () => {
    const io = memoryIo();
    await queueHaEntries(io, 'companion', () => [entry('a')], NOW);
    let outboxReads = 0;
    const flaky: HaSecretIo = {
      get: async (k) => {
        if (k === HA_OUTBOX_SECRET_KEY && ++outboxReads === 2) throw new Error('timeout');
        return io.get(k);
      },
      set: io.set,
    };
    const c = counting(200);
    const slow = (async (...args: Parameters<typeof fetch>) => {
      // The sync queues X while the send runs.
      await queueHaEntries(io, 'companion', () => [entry('X', at(30_000))], at(30_000));
      return c.fetch(...args);
    }) as typeof fetch;
    await expect(drainHomeAssistant(flaky, slow, NOW)).rejects.toThrow('timeout');
    expect(parseHaOutbox(io.data.get(HA_OUTBOX_SECRET_KEY)).pending.map((e) => e.id)).toEqual(['a', 'X']);
    // Next pass: 'a' is recorded as delivered, not sent again; X goes out.
    expect(await drainHomeAssistant(io, c.fetch, at(5 * 60_000))).toBe(1);
    expect(c.calls()).toBe(2);
    expect(parseHaOutbox(io.data.get(HA_OUTBOX_SECRET_KEY)).pending).toEqual([]);
  });

  it('a failed write of the outbox is reported, and what went out is not sent again', async () => {
    const io = memoryIo();
    await queueHaEntries(io, 'companion', () => [entry('a'), entry('b')], NOW);
    const unwritable: HaSecretIo = { get: io.get, set: async () => { throw new Error('session expired'); } };
    const c = counting(200);
    await expect(drainHomeAssistant(unwritable, c.fetch, NOW)).rejects.toThrow('session expired');
    expect(c.calls()).toBe(2);
    expect(await drainHomeAssistant(io, c.fetch, at(5 * 60_000))).toBe(0);
    expect(c.calls()).toBe(2);
    expect(parseHaOutbox(io.data.get(HA_OUTBOX_SECRET_KEY)).pending).toEqual([]);
  });

  it('keeps an alert the companion\'s own sync queued while the sends ran', async () => {
    const io = memoryIo();
    await queueHaEntries(io, 'companion', () => [haTestEntry(NOW)], NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const slow = (async () => {
      await queueHaEntries(io, 'companion', () => [haTestEntry(later)], later);
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await drainHomeAssistant(io, slow, NOW)).toBe(1);
    expect(parseHaOutbox(io.data.get(HA_OUTBOX_SECRET_KEY)).pending.map((e) => e.id)).toEqual([`test:${later.toISOString()}`]);
  });

  it('sends once when two drains overlap', async () => {
    const io = memoryIo();
    await queueHaEntries(io, 'companion', () => [haTestEntry(NOW)], NOW);
    const c = counting(200);
    await Promise.all([drainHomeAssistant(io, c.fetch, NOW), drainHomeAssistant(io, c.fetch, NOW)]);
    expect(c.calls()).toBe(1);
  });

  it('does nothing, and writes nothing, with an empty outbox', async () => {
    const io = memoryIo();
    expect(await drainHomeAssistant(io, answering(500), NOW)).toBe(0);
    expect(io.data.has(HA_STATUS_SECRET_KEY)).toBe(false);
  });

  it('a week of alerts aging out keeps the error and says they were dropped, not Connected', async () => {
    const io = memoryIo();
    await queueHaEntries(io, 'companion', () => [entry('a'), entry('b')], NOW);
    await drainHomeAssistant(io, answering(401), NOW);
    const failed = statusOf(io);
    await drainHomeAssistant(io, answering(200), at(8 * DAY));
    expect(statusOf(io)).toEqual({ ...failed, dropped: 2, droppedAt: at(8 * DAY).toISOString() });
    expect(parseHaOutbox(io.data.get(HA_OUTBOX_SECRET_KEY)).pending).toEqual([]);
  });

  it('queues the sync-failing alert once per streak', async () => {
    const io = memoryIo();
    await queueSyncHealthForHomeAssistant(io, '2027-03-14T10:00:00.000Z', 'HTTP 403', NOW);
    await queueSyncHealthForHomeAssistant(io, '2027-03-14T10:00:00.000Z', 'HTTP 403', NOW);
    expect(parseHaOutbox(io.data.get(HA_OUTBOX_SECRET_KEY)).pending).toHaveLength(1);
  });
});

describe('the 5-minute drain without Home Assistant set up', () => {
  it('reads the config once per 15 minutes, not every tick', async () => {
    expect(haDrainDue(NOW.getTime())).toBe(true);
    await drainHomeAssistant(memoryIo(false), answering(200), NOW);
    expect(haKnownSetUp()).toBe(false);
    expect(haDrainDue(at(5 * 60_000).getTime())).toBe(false);
    expect(haDrainDue(at(HA_IDLE_RECHECK_MS).getTime())).toBe(true);
  });

  it('drains every tick once it is set up', async () => {
    await drainHomeAssistant(memoryIo(), answering(200), NOW);
    expect(haKnownSetUp()).toBe(true);
    expect(haDrainDue(at(5 * 60_000).getTime())).toBe(true);
  });
});
