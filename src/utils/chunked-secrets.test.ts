import { describe, it, expect, vi } from 'vitest';
import {
  chunkedSecrets, withChunkedSecrets, SECRET_PLATFORM_LIMIT_CHARS, SECRET_PART_CHARS, CHUNKED_MARKER_KEY,
  type SecretsApi,
} from './chunked-secrets';

/** Wealthfolio's own refusal on Windows, word for word (issue #58). */
const WINDOWS_REFUSAL =
  "Secret store error: Value of 'password encoded as UTF-16' is longer than the platform limit of 2560 chars";

/** Wealthfolio 3.13's text for every keyring failure: the reason is gone. */
const GENERIC_REFUSAL = 'The operation could not be completed.';

/** A secret store backed by a Map. `limit` mimics Windows Credential Manager:
 *  2,560 bytes of UTF-16, i.e. 1,280 JS chars. No limit is the server's file store.
 *  `refusal` is the text a refused value comes back with (3.12's by default). */
function fakeStore(opts: { limit?: number; refusal?: string } = {}) {
  const data = new Map<string, string>();
  const api: SecretsApi = {
    get: vi.fn(async (k: string) => data.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      if (opts.limit !== undefined && v.length > opts.limit) throw new Error(opts.refusal ?? WINDOWS_REFUSAL);
      data.set(k, v);
    }),
    delete: vi.fn(async (k: string) => { data.delete(k); }),
  };
  return { api, data };
}

const windowsStore = () => fakeStore({ limit: SECRET_PLATFORM_LIMIT_CHARS });

/** A deterministic JSON-ish value of `n` chars. */
const bigValue = (n: number, seed = 'x') => JSON.stringify({ seed, pad: 'a'.repeat(Math.max(0, n - 20 - seed.length)) }).padEnd(n, ' ');

describe('chunkedSecrets on a store with no size limit (the server)', () => {
  it('stores a large value as one plain secret: no parts and no marker', async () => {
    const { api, data } = fakeStore();
    const secrets = chunkedSecrets(api);
    const v = bigValue(5000);
    await secrets.set('linked_groups', v);
    expect([...data.keys()]).toEqual(['linked_groups']);
    expect(data.get('linked_groups')).toBe(v);
    expect(await secrets.get('linked_groups')).toBe(v);
  });

  it('rethrows a refusal that is not about size, and never stores parts for it', async () => {
    const { api, data } = fakeStore();
    api.set = vi.fn(async () => { throw new Error('HTTP 500: database is locked'); });
    const secrets = chunkedSecrets(api);
    await expect(secrets.set('linked_groups', bigValue(5000))).rejects.toThrow(/database is locked/);
    expect(data.size).toBe(0);
  });

  it('does not mistake a timeout worded "took longer than" for a size refusal', async () => {
    const { api, data } = fakeStore();
    const realSet = api.set;
    api.set = vi.fn(async (k: string, v: string) => {
      if (k === 'linked_groups') throw new Error('Request took longer than 30000ms');
      return realSet(k, v);
    });
    const secrets = chunkedSecrets(api);
    await expect(secrets.set('linked_groups', bigValue(5000))).rejects.toThrow(/30000ms/);
    expect(data.size).toBe(0);
  });
});

describe('chunkedSecrets on Windows (issue #58)', () => {
  it('stores a value over the limit in parts that each fit, and reads it back whole', async () => {
    const { api, data } = windowsStore();
    const secrets = chunkedSecrets(api);
    const v = bigValue(5000);
    await secrets.set('linked_groups', v);
    for (const stored of data.values()) expect(stored.length).toBeLessThanOrEqual(SECRET_PLATFORM_LIMIT_CHARS);
    expect(data.get(CHUNKED_MARKER_KEY)).toBe('1');
    expect(data.get('linked_groups')).not.toBe(v);
    expect(await secrets.get('linked_groups')).toBe(v);
  });

  it('keeps every part key within what Wealthfolio accepts', async () => {
    const { api, data } = windowsStore();
    await chunkedSecrets(api).set('transfer_link_failures', bigValue(4000));
    for (const k of data.keys()) {
      expect(k).toMatch(/^[a-z0-9._-]+$/);
      expect(k.length).toBeLessThanOrEqual(128);
    }
  });

  it('stores a value of exactly the limit as it is', async () => {
    const { api, data } = windowsStore();
    const v = 'z'.repeat(SECRET_PLATFORM_LIMIT_CHARS);
    await chunkedSecrets(api).set('account_balances', v);
    expect(data.get('account_balances')).toBe(v);
    expect(data.has(CHUNKED_MARKER_KEY)).toBe(false);
  });

  it('never splits an emoji across two parts', async () => {
    const { api, data } = windowsStore();
    const secrets = chunkedSecrets(api);
    // Odd offset so a pair straddles every boundary somewhere.
    const v = 'q' + '💸'.repeat(3000);
    await secrets.set('account_names', v);
    for (const [k, stored] of data) {
      if (k === 'account_names' || k === CHUNKED_MARKER_KEY) continue;
      expect(stored).not.toMatch(/^[\uDC00-\uDFFF]/);
      expect(stored).not.toMatch(/[\uD800-\uDBFF]$/);
    }
    expect(await secrets.get('account_names')).toBe(v);
  });

  it('removes the old parts when a large value is replaced by a small one', async () => {
    const { api, data } = windowsStore();
    const secrets = chunkedSecrets(api);
    await secrets.set('linked_groups', bigValue(5000));
    await secrets.set('linked_groups', '{}');
    expect(await secrets.get('linked_groups')).toBe('{}');
    expect([...data.keys()].sort()).toEqual([CHUNKED_MARKER_KEY, 'linked_groups'].sort());
  });

  it('removes the old parts when a large value is replaced by another large one', async () => {
    const { api, data } = windowsStore();
    const secrets = chunkedSecrets(api);
    await secrets.set('linked_groups', bigValue(5000, 'first'));
    const keysAfterFirst = data.size;
    const second = bigValue(5000, 'second');
    await secrets.set('linked_groups', second);
    expect(await secrets.get('linked_groups')).toBe(second);
    expect(data.size).toBe(keysAfterFirst);
  });

  it('delete removes the value and all of its parts', async () => {
    const { api, data } = windowsStore();
    const secrets = chunkedSecrets(api);
    await secrets.set('linked_groups', bigValue(5000));
    await secrets.delete('linked_groups');
    expect(await secrets.get('linked_groups')).toBeNull();
    expect([...data.keys()]).toEqual([CHUNKED_MARKER_KEY]);
  });

  it('a later session cleans up parts it never read, on its first small write', async () => {
    const { api, data } = windowsStore();
    await chunkedSecrets(api).set('linked_groups', bigValue(5000));
    // App restart: a new layer over the same store, writing before any read.
    await chunkedSecrets(api).set('linked_groups', '{}');
    expect([...data.keys()].sort()).toEqual([CHUNKED_MARKER_KEY, 'linked_groups'].sort());
  });

  it('a later session writes large values straight to parts without a refused attempt', async () => {
    const { api } = windowsStore();
    await chunkedSecrets(api).set('linked_groups', bigValue(5000));
    vi.mocked(api.set).mockClear();
    const next = chunkedSecrets(api);
    await next.set('account_balances', bigValue(3000));
    const attempts = vi.mocked(api.set).mock.calls.filter(([k, v]) => k === 'account_balances' && v.length > SECRET_PLATFORM_LIMIT_CHARS);
    expect(attempts).toHaveLength(0);
    expect(await next.get('account_balances')).toBe(bigValue(3000));
  });

  it('a marker read that fails fails the write, and is asked again next time', async () => {
    const { api, data } = windowsStore();
    await chunkedSecrets(api).set('linked_groups', bigValue(5000));
    const next = chunkedSecrets(api);
    const realGet = api.get;
    api.get = vi.fn(async (k: string) => {
      if (k === CHUNKED_MARKER_KEY) throw new Error('Secret store error: busy');
      return realGet(k);
    });
    // Not "never chunked": that would overwrite the header and strand its parts.
    await expect(next.set('linked_groups', '{}')).rejects.toThrow(/busy/);
    api.get = realGet;
    await next.set('linked_groups', '{}');
    expect([...data.keys()].sort()).toEqual([CHUNKED_MARKER_KEY, 'linked_groups'].sort());
  });

  it('treats a damaged header as unreadable, not as the stored value', async () => {
    const { api, data } = windowsStore();
    const secrets = chunkedSecrets(api);
    await secrets.set('linked_groups', bigValue(5000));
    data.set('linked_groups', 'sfin-chunked-v1 {"g":"abc","n":');
    await expect(secrets.get('linked_groups')).rejects.toThrow(/linked_groups/);
  });

  it('treats keys as Wealthfolio does, case-insensitively', async () => {
    const { api } = windowsStore();
    const secrets = chunkedSecrets(api);
    const v = bigValue(5000);
    await Promise.all([secrets.set('Linked_Groups', bigValue(3000)), secrets.set('linked_groups', v)]);
    expect(await secrets.get('LINKED_GROUPS')).toBe(v);
  });

  it('refuses to hand back a value with a missing part rather than returning null', async () => {
    const { api, data } = windowsStore();
    const secrets = chunkedSecrets(api);
    await secrets.set('linked_groups', bigValue(5000));
    const part = [...data.keys()].find((k) => k.startsWith('linked_groups.'))!;
    data.delete(part);
    await expect(secrets.get('linked_groups')).rejects.toThrow(/linked_groups/);
  });

  it('two overlapping writes to one key end with the last value and no stray parts', async () => {
    const { api, data } = windowsStore();
    const secrets = chunkedSecrets(api);
    const a = bigValue(5000, 'a');
    const b = bigValue(4000, 'b');
    await Promise.all([secrets.set('linked_groups', a), secrets.set('linked_groups', b)]);
    expect(await secrets.get('linked_groups')).toBe(b);
    const parts = [...data.keys()].filter((k) => k.startsWith('linked_groups.'));
    expect(parts).toHaveLength(Math.ceil(b.length / SECRET_PART_CHARS));
  });

  it('a read waits for a write to the same key that is still running', async () => {
    const { api } = windowsStore();
    const secrets = chunkedSecrets(api);
    const v = bigValue(5000);
    const write = secrets.set('linked_groups', v);
    const read = secrets.get('linked_groups');
    await write;
    expect(await read).toBe(v);
  });

  it('leaves no parts behind when a part write fails', async () => {
    const { api, data } = windowsStore();
    const secrets = chunkedSecrets(api);
    await secrets.set('linked_groups', '{}');
    const realSet = api.set;
    let calls = 0;
    api.set = vi.fn(async (k: string, v: string) => {
      if (k.startsWith('linked_groups.') && ++calls === 3) throw new Error('Secret store error: access denied');
      return realSet(k, v);
    });
    await expect(secrets.set('linked_groups', bigValue(5000))).rejects.toThrow(/access denied/);
    expect(await secrets.get('linked_groups')).toBe('{}');
    expect([...data.keys()].filter((k) => k.startsWith('linked_groups.'))).toEqual([]);
  });
});

describe('chunkedSecrets on Wealthfolio 3.13, which no longer says why a value was refused', () => {
  const windows313 = () => fakeStore({ limit: SECRET_PLATFORM_LIMIT_CHARS, refusal: GENERIC_REFUSAL });
  const onlyValueAndParts = (data: Map<string, string>, key: string) =>
    [...data.keys()].every((k) => k === CHUNKED_MARKER_KEY || k === key || k.startsWith(`${key}.part-`));

  it('still stores a value over the limit in parts, and reads it back whole', async () => {
    const { api, data } = windows313();
    const secrets = chunkedSecrets(api);
    const v = bigValue(5000);
    await secrets.set('linked_groups', v);
    for (const stored of data.values()) expect(stored.length).toBeLessThanOrEqual(SECRET_PLATFORM_LIMIT_CHARS);
    expect(data.get(CHUNKED_MARKER_KEY)).toBe('1');
    expect(onlyValueAndParts(data, 'linked_groups')).toBe(true);
    expect(await secrets.get('linked_groups')).toBe(v);
  });

  it('rethrows the refusal on a store with no size limit, and stores nothing for it', async () => {
    // The server's file store: one write fails for some other reason, with the same text.
    const { api, data } = fakeStore();
    const realSet = api.set;
    api.set = vi.fn(async (k: string, v: string) => {
      if (k === 'linked_groups') throw new Error(GENERIC_REFUSAL);
      return realSet(k, v);
    });
    await expect(chunkedSecrets(api).set('linked_groups', bigValue(5000))).rejects.toThrow(GENERIC_REFUSAL);
    expect([...data.keys()]).toEqual([]);
  });

  it('rethrows the refusal on a store that refuses every write, small ones too', async () => {
    const { api, data } = fakeStore();
    api.set = vi.fn(async () => { throw new Error(GENERIC_REFUSAL); });
    await expect(chunkedSecrets(api).set('linked_groups', bigValue(5000))).rejects.toThrow(GENERIC_REFUSAL);
    expect([...data.keys()]).toEqual([]);
  });

  it('rethrows the refusal of a value within the limit without testing the store', async () => {
    const { api } = fakeStore();
    api.set = vi.fn(async () => { throw new Error(GENERIC_REFUSAL); });
    await expect(chunkedSecrets(api).set('linked_groups', '{}')).rejects.toThrow(GENERIC_REFUSAL);
    expect(api.set).toHaveBeenCalledTimes(1);
  });
});

describe('withChunkedSecrets', () => {
  it('swaps in the chunking secrets and passes every other member through', async () => {
    const { api: secrets, data } = windowsStore();
    const getAll = vi.fn(async () => ['acct']);
    const ctx = { api: { secrets, accounts: { getAll } }, sidebar: { addItem: vi.fn() } };
    const wrapped = withChunkedSecrets(ctx);
    expect(wrapped.sidebar).toBe(ctx.sidebar);
    expect(await wrapped.api.accounts.getAll()).toEqual(['acct']);
    await wrapped.api.secrets.set('linked_groups', bigValue(5000));
    expect(data.has(CHUNKED_MARKER_KEY)).toBe(true);
  });

  it("works over the add-on sandbox's api, a proxy that invents every member on demand", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const store = new Map<string, string>();
    const host = (method: string, args: unknown[]) => {
      calls.push({ method, args });
      if (method === 'secrets.get') return Promise.resolve(store.get(args[0] as string) ?? null);
      if (method === 'secrets.set') { store.set(args[0] as string, args[1] as string); return Promise.resolve(); }
      return Promise.resolve(`called ${method}`);
    };
    // Shaped like createApiProxy in Wealthfolio's addon-sandbox-entry.tsx.
    const apiProxy = (path: string[] = []): unknown => new Proxy(function addonApiProxy() { return undefined; }, {
      get(_t, key) {
        if (key === 'then' || typeof key === 'symbol') return undefined;
        return apiProxy([...path, String(key)]);
      },
      apply(_t, _this, args: unknown[]) { return host(path.join('.'), args); },
    });
    const ctx = { api: apiProxy() as any, onDisable: vi.fn() };
    const wrapped = withChunkedSecrets(ctx);
    expect(await wrapped.api.accounts.getAll()).toBe('called accounts.getAll');
    await wrapped.api.secrets.set('ui_state', '{"activeTab":"home"}');
    expect(await wrapped.api.secrets.get('ui_state')).toBe('{"activeTab":"home"}');
    expect((wrapped.api as { then?: unknown }).then).toBeUndefined();
    expect(calls.map((c) => c.method)).toContain('secrets.set');
  });
});
