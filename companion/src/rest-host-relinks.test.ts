import { describe, it, expect, vi } from 'vitest';
import { RestSyncStore } from './rest-host.js';
import { RELINKS_SECRET_KEY } from '../../shared/relink.js';

describe('RestSyncStore — re-link answers', () => {
  const storeWith = (value: string | null) => {
    const getAddonSecret = vi.fn(async () => value);
    return { store: new RestSyncStore({ getAddonSecret } as any), getAddonSecret };
  };

  it('reads the confirmed re-links the add-on stores, under the same key', async () => {
    const doc = { confirmed: [{ wfAccountId: 'wf-chk', newId: 'sfin-new', oldIds: ['sfin-old'] }, { newId: 7 }], declined: ['wf|a|b'] };
    const { store, getAddonSecret } = storeWith(JSON.stringify(doc));
    expect(await store.getRelinkDecisions()).toEqual({ confirmed: [doc.confirmed[0]], declined: ['wf|a|b'] });
    expect(getAddonSecret).toHaveBeenCalledWith(expect.any(String), RELINKS_SECRET_KEY);
  });

  it('reads absent or corrupt answers as none, so nothing is acted on', async () => {
    expect(await storeWith(null).store.getRelinkDecisions()).toEqual({ confirmed: [], declined: [] });
    expect(await storeWith('not json').store.getRelinkDecisions()).toEqual({ confirmed: [], declined: [] });
  });
});
