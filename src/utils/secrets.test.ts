import { describe, it, expect, vi } from 'vitest';
import { SecretsStore } from './secrets';
import type { MappingRule, AccountMapping } from '../../shared/types';

const makeCtx = () => {
  const store: Record<string, string> = {};
  return {
    api: {
      secrets: {
        get: vi.fn(async (k: string) => store[k] ?? null),
        set: vi.fn(async (k: string, v: string) => { store[k] = v; }),
        delete: vi.fn(async (k: string) => { delete store[k]; }),
      },
    },
  } as any;
};

describe('SecretsStore', () => {
  it('roundtrips access URL', async () => {
    const ctx = makeCtx();
    const s = new SecretsStore(ctx);
    await s.setAccessUrl('https://user:pass@bridge.simplefin.org/simplefin');
    expect(await s.getAccessUrl()).toBe('https://user:pass@bridge.simplefin.org/simplefin');
  });

  it('returns null when access URL not set', async () => {
    const ctx = makeCtx();
    const s = new SecretsStore(ctx);
    expect(await s.getAccessUrl()).toBeNull();
  });

  it('roundtrips account mapping as JSON', async () => {
    const ctx = makeCtx();
    const s = new SecretsStore(ctx);
    const mapping: AccountMapping = { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' };
    await s.setAccountMapping(mapping);
    expect(await s.getAccountMapping()).toEqual(mapping);
  });

  it('roundtrips mapping rules as JSON', async () => {
    const ctx = makeCtx();
    const s = new SecretsStore(ctx);
    const rules: MappingRule[] = [
      { pattern: 'dividend', matchType: 'contains', activityType: 'DIVIDEND' },
    ];
    await s.setMappingRules(rules);
    expect(await s.getMappingRules()).toEqual(rules);
  });

  it('roundtrips syncScheduleHours', async () => {
    const ctx = makeCtx();
    const s = new SecretsStore(ctx);
    await s.setSyncScheduleHours(6);
    expect(await s.getSyncScheduleHours()).toBe(6);
  });

  it('roundtrips lastSyncAt as ISO date', async () => {
    const ctx = makeCtx();
    const s = new SecretsStore(ctx);
    const now = new Date('2024-06-01T12:00:00Z');
    await s.setLastSyncAt(now);
    const result = await s.getLastSyncAt();
    expect(result?.toISOString()).toBe(now.toISOString());
  });

  it('clearAll deletes all keys', async () => {
    const ctx = makeCtx();
    const s = new SecretsStore(ctx);
    await s.setAccessUrl('https://user:pass@bridge.simplefin.org/simplefin');
    await s.setSyncScheduleHours(6);
    await s.clearAll();
    expect(await s.getAccessUrl()).toBeNull();
    expect(await s.getSyncScheduleHours()).toBeNull();
  });
});
