/**
 * Large secrets on Windows (issue #58).
 *
 * The desktop app keeps add-on secrets in the OS keyring, and Windows
 * Credential Manager refuses a value over 2,560 bytes of UTF-16, which is 1,280
 * JS characters. Several records here grow past that (linked transfers,
 * account balances, the ledgers), and one refused write fails the whole sync.
 *
 * This layer sits between the add-on and `ctx.api.secrets`. A value that fits
 * is stored as it is. Only when the host refuses a value for its size is it
 * stored in parts. Up to Wealthfolio 3.12 the refusal said so; from 3.13 every
 * keyring failure reads "The operation could not be completed.", so a refused
 * large value is followed by a test of the store itself (`refusesOnlyForSize`):
 *
 *   key                 → `sfin-chunked-v1 {"g":gen,"n":parts,"len":…,"h":…}`
 *   key.part-<gen>-<i>  → the i-th slice, each well under the limit
 *
 * Because parts are only written after a size refusal, the server's file store
 * (no limit) never holds a chunked value, so the companion, which reads those
 * secrets directly, never sees one. A marker secret, written before the first
 * chunked value, tells a later session that old parts may exist and must be
 * cleaned up when a key is rewritten or deleted.
 */

export interface SecretsApi {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Windows Credential Manager's limit: 2,560 bytes of UTF-16. */
export const SECRET_PLATFORM_LIMIT_CHARS = 1280;
/** Slice size; leaves headroom under the limit. */
export const SECRET_PART_CHARS = 1000;
/** Written once, before the first chunked value; never removed. */
export const CHUNKED_MARKER_KEY = 'secret_store_chunked';

const HEADER_PREFIX = 'sfin-chunked-v1 ';
/** Wealthfolio's addon secret keys: ASCII letters, digits, '.', '_', '-'; at most 128. */
const MAX_KEY_LENGTH = 128;
/** The keyring's own wording ("…is longer than the platform limit of 2560
 *  chars"), up to Wealthfolio 3.12. Narrow on purpose: any other failure, such
 *  as a timeout that "took longer than 30000ms", must not turn into parts, which
 *  the companion cannot read. */
const SIZE_REFUSAL = /longer than the platform limit/i;
/** Written and deleted while testing whether the store has the size limit. */
const PROBE_KEY = 'secret_store_probe';
const READ_ATTEMPTS = 3;

interface Header {
  g: string;
  n: number;
  len: number;
  h: string;
}

function parseHeader(raw: string | null): Header | null {
  if (raw === null || !raw.startsWith(HEADER_PREFIX)) return null;
  try {
    const h = JSON.parse(raw.slice(HEADER_PREFIX.length)) as Partial<Header>;
    if (typeof h.g !== 'string' || !/^[a-z0-9]+$/.test(h.g)) return null;
    if (!Number.isInteger(h.n) || (h.n as number) < 1 || !Number.isInteger(h.len) || typeof h.h !== 'string') return null;
    return h as Header;
  } catch {
    return null;
  }
}

const partKey = (key: string, gen: string, i: number) => `${key}.part-${gen}-${i}`;

/** FNV-1a over UTF-16 code units: catches parts from two different writes. */
function checksum(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** Slices of at most `size` chars, never splitting a surrogate pair: a lone
 *  surrogate cannot cross the host's UTF-8 boundary intact. */
function split(value: string, size: number): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < value.length) {
    let end = Math.min(i + size, value.length);
    if (end < value.length) {
      const c = value.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff) end -= 1;
    }
    parts.push(value.slice(i, end));
    i = end;
  }
  return parts;
}

function isSizeRefusal(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return SIZE_REFUSAL.test(msg);
}

const newGen = () => Math.random().toString(36).slice(2, 10) || '0';

export function chunkedSecrets(inner: SecretsApi): SecretsApi {
  /** Whether this store has ever needed parts. Read once, lazily, on the first
   *  write; true from then on once a size refusal or a header is seen. A failed
   *  read is not remembered, and fails the write: guessing "never" would
   *  overwrite a header and strand its parts. */
  let limited: Promise<boolean> | null = null;
  const isLimited = (): Promise<boolean> => {
    if (limited) return limited;
    const read = inner.get(CHUNKED_MARKER_KEY).then(
      (v) => v === '1',
      (err: unknown) => {
        if (limited === read) limited = null;
        throw err;
      },
    );
    limited = read;
    return read;
  };
  const markLimited = async () => {
    if (await isLimited()) return;
    await inner.set(CHUNKED_MARKER_KEY, '1');
    limited = Promise.resolve(true);
  };

  /** Writes to one key run one after another, and reads wait for them. */
  const queues = new Map<string, Promise<unknown>>();
  const serialize = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const prev = queues.get(key) ?? Promise.resolve();
    const run = prev.then(work, work);
    const tail = run.catch(() => {});
    queues.set(key, tail);
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return run;
  };

  /** Whether the store refuses values only for their size. Wealthfolio 3.13
   *  reports every keyring failure as "The operation could not be completed.",
   *  so a refusal no longer says why; the store itself can. True only when a
   *  small value saves and one just over the limit doesn't: false on the
   *  server's file store (no limit) and on a store that refuses everything,
   *  where the original error stands. */
  const refusesOnlyForSize = async (): Promise<boolean> => {
    try {
      try {
        await inner.set(PROBE_KEY, '1');
      } catch {
        return false;
      }
      try {
        await inner.set(PROBE_KEY, 'x'.repeat(SECRET_PLATFORM_LIMIT_CHARS + 1));
        return false;
      } catch {
        return true;
      }
    } finally {
      await inner.delete(PROBE_KEY).catch(() => {});
    }
  };

  const deleteParts = async (key: string, header: Header) => {
    await Promise.allSettled(Array.from({ length: header.n }, (_, i) => inner.delete(partKey(key, header.g, i))));
  };

  /** The current header, if this store may hold one. Free where nothing was ever chunked. */
  const currentHeader = async (key: string): Promise<Header | null> =>
    (await isLimited()) ? parseHeader(await inner.get(key)) : null;

  const writeParts = async (key: string, value: string, old: Header | null) => {
    const gen = newGen();
    const parts = split(value, SECRET_PART_CHARS);
    const header: Header = { g: gen, n: parts.length, len: value.length, h: checksum(value) };
    if (partKey(key, gen, parts.length - 1).length > MAX_KEY_LENGTH) {
      throw new Error(`Secret '${key}' is too large to store, and its name is too long to store in parts`);
    }
    try {
      for (let i = 0; i < parts.length; i++) await inner.set(partKey(key, gen, i), parts[i]);
      // The switch: readers see the old value or the new one, never a mix.
      await inner.set(key, HEADER_PREFIX + JSON.stringify(header));
    } catch (err) {
      await deleteParts(key, header);
      throw err;
    }
    if (old) await deleteParts(key, old);
  };

  const readOnce = async (key: string): Promise<{ value: string | null } | null> => {
    const raw = await inner.get(key);
    if (raw === null || !raw.startsWith(HEADER_PREFIX)) return { value: raw };
    // A damaged header is unreadable, never the value: a caller would parse
    // it as nothing and write an empty record over the real one.
    const header = parseHeader(raw);
    if (!header) return null;
    limited = Promise.resolve(true);
    const parts = await Promise.all(Array.from({ length: header.n }, (_, i) => inner.get(partKey(key, header.g, i))));
    if (parts.some((p) => p === null)) return null;
    const value = parts.join('');
    return value.length === header.len && checksum(value) === header.h ? { value } : null;
  };

  // Wealthfolio lowercases addon secret keys, so two spellings are one secret
  // and must share one queue.
  return {
    async get(anyKey) {
      const key = anyKey.toLowerCase();
      for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
        await queues.get(key);
        const read = await readOnce(key);
        if (read) return read.value;
      }
      // Never null: a caller would read "nothing stored" and write an empty
      // record over the real one.
      throw new Error(`Secret '${key}' is stored in parts, and some are missing or don't match`);
    },

    set(anyKey, value) {
      const key = anyKey.toLowerCase();
      return serialize(key, async () => {
        if (value.length > SECRET_PLATFORM_LIMIT_CHARS && (await isLimited())) {
          await writeParts(key, value, await currentHeader(key));
          return;
        }
        const old = await currentHeader(key);
        try {
          await inner.set(key, value);
        } catch (err) {
          if (value.length <= SECRET_PLATFORM_LIMIT_CHARS) throw err;
          if (!isSizeRefusal(err) && !(await refusesOnlyForSize())) throw err;
          await markLimited();
          await writeParts(key, value, old);
          return;
        }
        if (old) await deleteParts(key, old);
      });
    },

    delete(anyKey) {
      const key = anyKey.toLowerCase();
      return serialize(key, async () => {
        const old = await currentHeader(key);
        await inner.delete(key);
        if (old) await deleteParts(key, old);
      });
    },
  };
}

/**
 * `ctx` with its `api.secrets` replaced by the chunking layer, everything else
 * passed through untouched. Proxies rather than copies: inside Wealthfolio's
 * add-on sandbox `ctx.api` is itself a proxy that invents members on demand,
 * so it has no own properties to copy and a spread would lose the whole API.
 */
export function withChunkedSecrets<C extends { api: { secrets: SecretsApi } }>(ctx: C): C {
  const secrets = chunkedSecrets(ctx.api.secrets);
  const api = new Proxy(ctx.api, {
    get: (target, prop) => (prop === 'secrets' ? secrets : Reflect.get(target, prop)),
  });
  return new Proxy(ctx, {
    get: (target, prop) => (prop === 'api' ? api : Reflect.get(target, prop)),
  });
}
