import { describe, it, expect } from 'vitest';
import { drainHomeAssistant, queueSyncHealthForHomeAssistant } from './home-assistant-host.js';
import {
  HA_CONFIG_SECRET_KEY, HA_OUTBOX_SECRET_KEY, HA_STATUS_SECRET_KEY, haTestEntry, parseHaOutbox, queueHaEntries,
  type HaSecretIo,
} from '../../shared/home-assistant.js';

const NOW = new Date('2027-03-15T15:00:00Z');
const CONFIG = { enabled: true, url: 'http://ha.local:8123', token: 'tok', service: 'mobile_app_phone' };

function memoryIo(): HaSecretIo & { data: Map<string, string> } {
  const data = new Map<string, string>([[HA_CONFIG_SECRET_KEY, JSON.stringify(CONFIG)]]);
  return { data, get: async (k) => data.get(k) ?? null, set: async (k, v) => { data.set(k, v); } };
}
const answering = (status: number) => (async () => new Response('', { status })) as unknown as typeof fetch;

describe('drainHomeAssistant', () => {
  it('sends what is queued, empties the outbox and records when it last worked', async () => {
    const io = memoryIo();
    await queueHaEntries(io, () => [haTestEntry(NOW)], NOW);
    expect(await drainHomeAssistant(io, answering(200), NOW)).toBe(1);
    expect(parseHaOutbox(io.data.get(HA_OUTBOX_SECRET_KEY)).pending).toEqual([]);
    expect(JSON.parse(io.data.get(HA_STATUS_SECRET_KEY)!)).toEqual({ lastOkAt: NOW.toISOString() });
  });

  it('keeps a failed alert queued and records the error for the settings to show', async () => {
    const io = memoryIo();
    await queueHaEntries(io, () => [haTestEntry(NOW)], NOW);
    expect(await drainHomeAssistant(io, answering(401), NOW)).toBe(0);
    expect(parseHaOutbox(io.data.get(HA_OUTBOX_SECRET_KEY)).pending).toHaveLength(1);
    expect(JSON.parse(io.data.get(HA_STATUS_SECRET_KEY)!)).toMatchObject({
      lastError: 'Home Assistant answered 401 (check the access token)', lastErrorAt: NOW.toISOString(),
    });
  });

  it('keeps an alert the add-on queued while the sends ran', async () => {
    const io = memoryIo();
    await queueHaEntries(io, () => [haTestEntry(NOW)], NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const slow = (async () => {
      await queueHaEntries(io, () => [haTestEntry(later)], later);
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await drainHomeAssistant(io, slow, NOW)).toBe(1);
    expect(parseHaOutbox(io.data.get(HA_OUTBOX_SECRET_KEY)).pending.map((e) => e.id)).toEqual([`test:${later.toISOString()}`]);
  });

  it('sends once when two drains overlap', async () => {
    const io = memoryIo();
    await queueHaEntries(io, () => [haTestEntry(NOW)], NOW);
    let calls = 0;
    const counting = (async () => { calls++; return new Response('', { status: 200 }); }) as unknown as typeof fetch;
    await Promise.all([drainHomeAssistant(io, counting, NOW), drainHomeAssistant(io, counting, NOW)]);
    expect(calls).toBe(1);
  });

  it('does nothing, and writes nothing, with an empty outbox', async () => {
    const io = memoryIo();
    expect(await drainHomeAssistant(io, answering(500), NOW)).toBe(0);
    expect(io.data.has(HA_STATUS_SECRET_KEY)).toBe(false);
  });

  it('queues the sync-failing alert once per streak', async () => {
    const io = memoryIo();
    await queueSyncHealthForHomeAssistant(io, '2027-03-14T10:00:00.000Z', 'HTTP 403', NOW);
    await queueSyncHealthForHomeAssistant(io, '2027-03-14T10:00:00.000Z', 'HTTP 403', NOW);
    expect(parseHaOutbox(io.data.get(HA_OUTBOX_SECRET_KEY)).pending).toHaveLength(1);
  });
});
