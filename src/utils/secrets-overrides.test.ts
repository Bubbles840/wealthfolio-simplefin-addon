import { describe, it, expect, vi } from 'vitest';
import { SecretsStore } from './secrets';
import { emptySyncOverrides, setAccountOverride, SYNC_OVERRIDES_SECRET_KEY } from '../../shared/sync-overrides';

const ctxOver = (data: Record<string, string>) => ({
  api: {
    secrets: {
      get: vi.fn(async (k: string) => data[k] ?? null),
      set: vi.fn(async (k: string, v: string) => { data[k] = v; }),
      delete: vi.fn(async (k: string) => { delete data[k]; }),
    },
  },
}) as any;

describe('SecretsStore — sync overrides', () => {
  it('reads the document under the key the companion reads too', async () => {
    const doc = setAccountOverride(emptySyncOverrides(), 'sfin-1', 'noAutoCorrect', new Date('2026-10-13T15:00:00Z'));
    expect(await new SecretsStore(ctxOver({ [SYNC_OVERRIDES_SECRET_KEY]: JSON.stringify(doc) })).getSyncOverrides()).toEqual(doc);
  });

  it('reads a corrupt document as empty, so the sync behaves as today', async () => {
    expect(await new SecretsStore(ctxOver({ [SYNC_OVERRIDES_SECRET_KEY]: 'not json' })).getSyncOverrides()).toEqual(emptySyncOverrides());
  });

  it('Reset clears it', async () => {
    const data = { [SYNC_OVERRIDES_SECRET_KEY]: '{"v":1}' };
    await new SecretsStore(ctxOver(data)).clearAll();
    expect(data[SYNC_OVERRIDES_SECRET_KEY]).toBeUndefined();
  });
});
