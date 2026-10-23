import { describe, it, expect, vi } from 'vitest';
import { SecretsStore } from './secrets';
import { RELINKS_SECRET_KEY, withConfirmed, withDeclined } from '../../shared/relink';
import { requireWealthfolioSecretKey } from '../../shared/__fixtures__/wealthfolio-secret-key';

const ctxOver = (data: Record<string, string>) => ({
  api: {
    secrets: {
      get: vi.fn(async (k: string) => { requireWealthfolioSecretKey(k); return data[k] ?? null; }),
      set: vi.fn(async (k: string, v: string) => { requireWealthfolioSecretKey(k); data[k] = v; }),
      delete: vi.fn(async (k: string) => { requireWealthfolioSecretKey(k); delete data[k]; }),
    },
  },
}) as any;

const Q = { wfAccountId: 'wf-chk', newId: 'sfin-new', oldIds: ['sfin-old'] };

describe('SecretsStore — re-link answers', () => {
  it('merges an answer into what is stored now, under the key the companion reads', async () => {
    const data: Record<string, string> = { [RELINKS_SECRET_KEY]: JSON.stringify({ confirmed: [], declined: ['wf-sav|sfin-a|sfin-b'] }) };
    const store = new SecretsStore(ctxOver(data));
    const next = await store.updateRelinkDecisions((d) => withConfirmed(d, Q));
    expect(next).toEqual({ confirmed: [Q], declined: ['wf-sav|sfin-a|sfin-b'] });
    expect(JSON.parse(data[RELINKS_SECRET_KEY])).toEqual(next);
    expect(await store.getRelinkDecisions()).toEqual(next);
  });

  it('refuses to write over a document it cannot read, and the mapping read says so', async () => {
    const data: Record<string, string> = { [RELINKS_SECRET_KEY]: '{"confirmed": [{"newId": 7}]}' };
    const store = new SecretsStore(ctxOver(data));
    await expect(store.readRelinkDecisions()).rejects.toThrow(/can't be read/);
    await expect(store.updateRelinkDecisions((d) => withDeclined(d, Q))).rejects.toThrow(/nothing was changed/);
    expect(data[RELINKS_SECRET_KEY]).toBe('{"confirmed": [{"newId": 7}]}');
    // The sync's own read stays lenient: what it cannot read confirms nothing.
    expect(await store.getRelinkDecisions()).toEqual({ confirmed: [], declined: [] });
  });

  it('reads absent as none, and Reset clears it', async () => {
    const data: Record<string, string> = {};
    const store = new SecretsStore(ctxOver(data));
    expect(await store.readRelinkDecisions()).toEqual({ confirmed: [], declined: [] });
    await store.updateRelinkDecisions((d) => withDeclined(d, Q));
    await store.clearAll();
    expect(data[RELINKS_SECRET_KEY]).toBeUndefined();
  });
});
