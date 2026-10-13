import { describe, it, expect, vi } from 'vitest';
import { RestSyncStore } from './rest-host.js';
import { emptySyncOverrides, setTxOverride, SYNC_OVERRIDES_SECRET_KEY } from '../../shared/sync-overrides.js';

const store = (secrets: Map<string, string>) => new RestSyncStore({
  getAddonSecret: vi.fn(async (_id: string, key: string) => secrets.get(key) ?? null),
  setAddonSecret: vi.fn(),
} as any);

describe('RestSyncStore — sync overrides', () => {
  it('reads the document the add-on writes, under the same key', async () => {
    const doc = setTxOverride(emptySyncOverrides(), 'sfin-1\u0000TRN-1', 'notTransfer', new Date('2026-10-13T15:00:00Z'));
    const read = await store(new Map([[SYNC_OVERRIDES_SECRET_KEY, JSON.stringify(doc)]])).getSyncOverrides();
    expect(read).toEqual(doc);
  });

  it('reads a corrupt document, an absent one and a failed read as empty, so the sync behaves as today', async () => {
    expect(await store(new Map([[SYNC_OVERRIDES_SECRET_KEY, '{"v":1,"tx":7}']])).getSyncOverrides()).toEqual(emptySyncOverrides());
    expect(await store(new Map()).getSyncOverrides()).toEqual(emptySyncOverrides());
    const failing = new RestSyncStore({ getAddonSecret: vi.fn(async () => { throw new Error('502'); }), setAddonSecret: vi.fn() } as any);
    expect(await failing.getSyncOverrides()).toEqual(emptySyncOverrides());
  });
});
