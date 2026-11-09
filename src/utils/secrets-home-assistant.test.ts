import { describe, it, expect, vi } from 'vitest';
import { SecretsStore } from './secrets';
import {
  HA_ADDON_QUEUE_SECRET_KEY, HA_CONFIG_SECRET_KEY, HA_OUTBOX_SECRET_KEY, parseHaOutbox,
  type HomeAssistantConfig,
} from '../../shared/home-assistant';

const ctxOver = (data: Record<string, string>) => ({
  api: {
    secrets: {
      get: vi.fn(async (k: string) => data[k] ?? null),
      set: vi.fn(async (k: string, v: string) => { data[k] = v; }),
      delete: vi.fn(async (k: string) => { delete data[k]; }),
    },
  },
}) as any;

const CONFIG: HomeAssistantConfig = {
  enabled: true, mode: 'notify', url: 'http://ha.local:8123', token: 'tok', service: 'mobile_app_phone',
  titlePrefix: '', linkBase: '', notifyOnImport: true, notifyOnImportTrades: false,
};

describe('SecretsStore — Home Assistant', () => {
  it('Reset clears the token, both queues and the delivery status they hold', async () => {
    const data: Record<string, string> = {
      [HA_CONFIG_SECRET_KEY]: JSON.stringify(CONFIG),
      [HA_OUTBOX_SECRET_KEY]: '{"pending":[],"seen":{},"status":{"lastOkAt":"2027-03-15T15:00:00.000Z"}}',
      [HA_ADDON_QUEUE_SECRET_KEY]: '{"pending":[],"seen":{}}',
    };
    await new SecretsStore(ctxOver(data)).clearAll();
    expect(data).toEqual({});
  });

  it('saves the import switches with the rest of the config', async () => {
    const data: Record<string, string> = {};
    const store = new SecretsStore(ctxOver(data));
    await store.setHomeAssistantConfig(CONFIG);
    expect(await store.getHomeAssistantConfig()).toEqual(CONFIG);
  });

  it('queues a test into the add-on\'s own key, and says when Home Assistant is off', async () => {
    const data: Record<string, string> = { [HA_CONFIG_SECRET_KEY]: JSON.stringify(CONFIG) };
    const store = new SecretsStore(ctxOver(data));
    expect(await store.queueHomeAssistantTest()).toBe('queued');
    expect(parseHaOutbox(data[HA_ADDON_QUEUE_SECRET_KEY]).pending).toHaveLength(1);
    expect(data[HA_OUTBOX_SECRET_KEY]).toBeUndefined();
    data[HA_CONFIG_SECRET_KEY] = JSON.stringify({ ...CONFIG, enabled: false });
    expect(await store.queueHomeAssistantTest()).toBe('off');
  });

  it('reads the delivery status from the companion\'s outbox', async () => {
    const data: Record<string, string> = { [HA_OUTBOX_SECRET_KEY]: '{"pending":[],"seen":{},"status":{"lastOkAt":"t"}}' };
    expect(await new SecretsStore(ctxOver(data)).getHomeAssistantStatus()).toEqual({ lastOkAt: 't' });
    expect(await new SecretsStore(ctxOver({})).getHomeAssistantStatus()).toBeNull();
  });
});
