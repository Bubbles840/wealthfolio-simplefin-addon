import { describe, it, expect, vi } from 'vitest';
import { SecretsStore } from './secrets';
import { IGNORE_RULES_SECRET_KEY, IgnoreRulesUnreadableError, type IgnoreRule } from '../../shared/ignore-rules';

const ctxOver = (data: Record<string, string>) => ({
  api: {
    secrets: {
      get: vi.fn(async (k: string) => data[k] ?? null),
      set: vi.fn(async (k: string, v: string) => { data[k] = v; }),
      delete: vi.fn(async (k: string) => { delete data[k]; }),
    },
  },
}) as any;

const sweep: IgnoreRule = { pattern: 'SWEEP FROM CORE FUND', matchType: 'contains', account: 'sfin-1' };

describe('SecretsStore — ignore rules', () => {
  it('writes the rules under the key the companion reads, and reads them back', async () => {
    const data: Record<string, string> = {};
    const store = new SecretsStore(ctxOver(data));
    await store.setIgnoreRules([{ ...sweep, pattern: ' SWEEP FROM CORE FUND ', note: ' sweep ' }]);
    expect(JSON.parse(data[IGNORE_RULES_SECRET_KEY])).toEqual([{ ...sweep, note: 'sweep' }]);
    expect(await store.getIgnoreRules()).toEqual([{ ...sweep, note: 'sweep' }]);
    expect(await store.readIgnoreRules()).toEqual({ kind: 'ok', list: [{ ...sweep, note: 'sweep' }] });
  });

  it('refuses a rule that would ignore every transaction, writing nothing', async () => {
    const data: Record<string, string> = { [IGNORE_RULES_SECRET_KEY]: JSON.stringify([sweep]) };
    const store = new SecretsStore(ctxOver(data));
    await expect(store.setIgnoreRules([sweep, { pattern: '', matchType: 'contains' }])).rejects.toThrow(/empty rule/);
    await expect(store.setIgnoreRules([{ pattern: '.*', matchType: 'regex' }])).rejects.toThrow(/every transaction/);
    expect(JSON.parse(data[IGNORE_RULES_SECRET_KEY])).toEqual([sweep]);
  });

  it('writes nothing over a stored list it cannot read', async () => {
    const data: Record<string, string> = { [IGNORE_RULES_SECRET_KEY]: 'not json' };
    const store = new SecretsStore(ctxOver(data));
    expect(await store.readIgnoreRules()).toEqual({ kind: 'corrupt' });
    expect(await store.getIgnoreRules()).toEqual([]);
    await expect(store.setIgnoreRules([sweep])).rejects.toBeInstanceOf(IgnoreRulesUnreadableError);
    expect(data[IGNORE_RULES_SECRET_KEY]).toBe('not json');
  });

  it('Reset clears it', async () => {
    const data = { [IGNORE_RULES_SECRET_KEY]: JSON.stringify([sweep]) };
    await new SecretsStore(ctxOver(data)).clearAll();
    expect(data[IGNORE_RULES_SECRET_KEY]).toBeUndefined();
  });
});
