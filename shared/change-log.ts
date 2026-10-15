/**
 * shared/change-log.ts
 *
 * Where change entries live: add-on settings, one bucket per writer per month
 * (`change_log:<writer>:<YYYY-MM>`), so the two writers — the add-on and the
 * companion — never write the same key. Secrets have no compare-and-swap and
 * no list operation; one key per writer is what makes a read-append-write safe
 * without either.
 *
 * - A CORRUPT bucket is never overwritten. The writer appends to the fallback
 *   `<key>.2` instead; readers read both. If the fallback is corrupt too,
 *   appends for that writer and month pause (the feed says so).
 * - The cap is 200,000 UTF-8 bytes per bucket. Over it, bookkeeping goes first
 *   (oldest first), then the oldest entries; the count lands in `trimmed`.
 * - Retention: readers read this month and the three before it and drop
 *   anything older than 90 days; a writer, on its first append of a month,
 *   clears its own bucket from four months back.
 * - A failed append is remembered in memory and written as a `gaps` record on
 *   the next successful one, so a missing stretch is visible, not silent.
 */
import type { ChangeEntry, ChangeWriter } from './change-entries.js';
import type { SecretGet, SecretSet } from './subscription-prefs.js';

export const CHANGE_LOG_KEY_PREFIX = 'change_log';
export const CHANGE_LOG_FALLBACK_SUFFIX = '.2';
export const CHANGE_LOG_CAP_BYTES = 200_000;
/** This month and the three before it. */
export const CHANGE_LOG_READ_MONTHS = 4;
/** A writer clears its own bucket this many months back. Reset clears through it. */
export const CHANGE_LOG_CLEAR_MONTHS_BACK = 4;
/** On its first append of a month a writer clears months -4 through -12, so a
 *  writer that skipped months (nothing to write, or the app closed) still
 *  leaves nothing older behind. Clearing an empty key is idempotent. */
export const CHANGE_LOG_CLEAR_MONTHS_THROUGH = 12;
export const CHANGE_LOG_RETENTION_DAYS = 90;
/** Gap records kept per bucket, newest last. */
export const CHANGE_LOG_MAX_GAPS = 50;
export const CHANGE_LOG_WRITERS: readonly ChangeWriter[] = ['addon', 'companion'];

export const GAP_REASON_WRITE = "couldn't save the log";
export const GAP_REASON_UNREADABLE = "the log couldn't be read";

export interface ChangeGap { at: string; count: number; reason: string }

export interface ChangeBucket {
  v: 1;
  writer: ChangeWriter;
  month: string;
  entries: ChangeEntry[];
  gaps: ChangeGap[];
  trimmed?: number;
}

export type ParsedChangeBucket =
  | { kind: 'ok'; bucket: ChangeBucket }
  | { kind: 'absent' }
  | { kind: 'corrupt' };

/** Both the bucket and its fallback are unreadable: nothing can be appended. */
export class ChangeLogPausedError extends Error {
  constructor(readonly writer: ChangeWriter, readonly month: string) {
    super(`The ${writer} change log for ${month} cannot be read, so nothing was added to it`);
    this.name = 'ChangeLogPausedError';
  }
}

/** UTC `YYYY-MM` of a moment. */
export function changeMonth(at: Date | string): string {
  return (typeof at === 'string' ? new Date(at) : at).toISOString().slice(0, 7);
}

/** `YYYY-MM` plus `n` months (negative goes back). */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export function changeLogKey(writer: ChangeWriter, month: string, fallback = false): string {
  return `${CHANGE_LOG_KEY_PREFIX}:${writer}:${month}${fallback ? CHANGE_LOG_FALLBACK_SUFFIX : ''}`;
}

/** Every key Reset must clear: both writers, both keys, this month and the
 *  four before it. Generated, because the secrets API cannot list keys. */
export function changeLogResetKeys(now: Date): string[] {
  const month = changeMonth(now);
  const keys: string[] = [];
  for (let back = 0; back <= CHANGE_LOG_CLEAR_MONTHS_BACK; back++) {
    for (const writer of CHANGE_LOG_WRITERS) {
      keys.push(changeLogKey(writer, shiftMonth(month, -back)), changeLogKey(writer, shiftMonth(month, -back), true));
    }
  }
  return keys;
}

export function emptyChangeBucket(writer: ChangeWriter, month: string): ChangeBucket {
  return { v: 1, writer, month, entries: [], gaps: [] };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function isEntry(v: unknown): v is ChangeEntry {
  return isRecord(v)
    && typeof v.id === 'string' && typeof v.at === 'string' && typeof v.kind === 'string'
    && typeof v.summary === 'string' && (v.writer === 'addon' || v.writer === 'companion')
    && (v.actor === 'auto' || v.actor === 'you') && isRecord(v.subject) && typeof v.undoable === 'boolean';
}

const isGap = (v: unknown): v is ChangeGap =>
  isRecord(v) && typeof v.at === 'string' && typeof v.count === 'number' && typeof v.reason === 'string';

/**
 * `absent` for nothing stored — including `''`, which is how the companion
 * clears a key. `corrupt` for anything that is not exactly this writer's
 * bucket for this month: a bucket another version or a hand edit mangled must
 * be left alone, never "repaired" by overwriting it. Unknown entry KINDS are
 * fine — a newer writer's entries still show their summary.
 */
export function parseChangeBucket(raw: string | null | undefined, writer: ChangeWriter, month: string): ParsedChangeBucket {
  if (raw === null || raw === undefined || raw === '') return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  if (!isRecord(parsed) || parsed.v !== 1 || parsed.writer !== writer || parsed.month !== month) return { kind: 'corrupt' };
  if (!Array.isArray(parsed.entries) || !parsed.entries.every(isEntry)) return { kind: 'corrupt' };
  const gaps = parsed.gaps === undefined ? [] : parsed.gaps;
  if (!Array.isArray(gaps) || !gaps.every(isGap)) return { kind: 'corrupt' };
  if (parsed.trimmed !== undefined && typeof parsed.trimmed !== 'number') return { kind: 'corrupt' };
  return {
    kind: 'ok',
    bucket: {
      v: 1, writer, month, entries: parsed.entries as ChangeEntry[], gaps: gaps as ChangeGap[],
      ...(typeof parsed.trimmed === 'number' ? { trimmed: parsed.trimmed } : {}),
    },
  };
}

const encoder = new TextEncoder();
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/**
 * The bucket, cut to `cap` bytes of JSON. Bookkeeping goes first, oldest
 * first; then the oldest entries of any kind. Entries are stored in the order
 * they were appended, so index 0 is the oldest.
 */
export function enforceChangeCap(bucket: ChangeBucket, cap = CHANGE_LOG_CAP_BYTES): ChangeBucket {
  const size = (b: ChangeBucket) => utf8Bytes(JSON.stringify(b));
  if (size(bucket) <= cap) return bucket;
  const all = bucket.entries;
  const order = [
    ...all.map((e, i) => [e, i] as const).filter(([e]) => e.kind === 'bookkeeping').map(([, i]) => i),
    ...all.map((e, i) => [e, i] as const).filter(([e]) => e.kind !== 'bookkeeping').map(([, i]) => i),
  ];
  const dropped = new Set<number>();
  // Measured once per entry, then subtracted: re-serialising after every drop
  // is quadratic on a 200 KB bucket. Reserve room for the `trimmed` count.
  let over = size({ ...bucket, trimmed: (bucket.trimmed ?? 0) + all.length }) - cap;
  for (const i of order) {
    if (over <= 0) break;
    dropped.add(i);
    over -= utf8Bytes(JSON.stringify(all[i])) + 1;
  }
  let next: ChangeBucket = {
    ...bucket, entries: all.filter((_, i) => !dropped.has(i)), trimmed: (bucket.trimmed ?? 0) + dropped.size,
  };
  // The estimate is close; settle it exactly.
  while (size(next) > cap && next.entries.length > 0) {
    const at = next.entries.findIndex((e) => e.kind === 'bookkeeping');
    const cut = at === -1 ? 0 : at;
    next = { ...next, entries: next.entries.filter((_, i) => i !== cut), trimmed: (next.trimmed ?? 0) + 1 };
  }
  return next;
}

/** The key a writer may append to for a month, and what is in it. */
async function writableBucket(get: SecretGet, writer: ChangeWriter, month: string): Promise<{ key: string; bucket: ChangeBucket }> {
  const primary = changeLogKey(writer, month);
  const first = parseChangeBucket(await get(primary), writer, month);
  if (first.kind === 'ok') return { key: primary, bucket: first.bucket };
  if (first.kind === 'absent') return { key: primary, bucket: emptyChangeBucket(writer, month) };
  const fallback = changeLogKey(writer, month, true);
  const second = parseChangeBucket(await get(fallback), writer, month);
  if (second.kind === 'ok') return { key: fallback, bucket: second.bucket };
  if (second.kind === 'absent') return { key: fallback, bucket: emptyChangeBucket(writer, month) };
  throw new ChangeLogPausedError(writer, month);
}

/**
 * Re-read the bucket(s), append, enforce the cap, write once per month
 * touched. Entries go to the month of their own `at`; `gaps` ride along with
 * the first bucket written. Throws when the host does, or with
 * `ChangeLogPausedError` — the caller (`createChangeLogWriter`) turns either
 * into a gap.
 */
export async function appendChanges(
  get: SecretGet,
  set: SecretSet,
  writer: ChangeWriter,
  entries: ChangeEntry[],
  now: Date,
  gaps: ChangeGap[] = [],
): Promise<void> {
  if (entries.length === 0 && gaps.length === 0) return;
  const byMonth = new Map<string, ChangeEntry[]>();
  for (const e of entries) {
    const month = changeMonth(e.at);
    byMonth.set(month, [...(byMonth.get(month) ?? []), e]);
  }
  if (byMonth.size === 0) byMonth.set(changeMonth(now), []);
  let carry = gaps;
  for (const month of [...byMonth.keys()].sort()) {
    const { key, bucket } = await writableBucket(get, writer, month);
    const next = enforceChangeCap({
      ...bucket,
      entries: [...bucket.entries, ...(byMonth.get(month) ?? [])],
      gaps: [...bucket.gaps, ...carry].slice(-CHANGE_LOG_MAX_GAPS),
    });
    await set(key, JSON.stringify(next));
    carry = [];
  }
}

/** How a writer reaches its storage. `clear` removes a key: `set(key, '')` on
 *  the companion, `secrets.delete` on the add-on. */
export interface ChangeLogIo {
  get: SecretGet;
  set: SecretSet;
  clear(key: string): Promise<void>;
}

export interface ChangeLogWriter {
  readonly writer: ChangeWriter;
  /** Never rejects. Appends run one after another, in call order. */
  append(io: ChangeLogIo, entries: ChangeEntry[]): Promise<void>;
  /** As `append` (same queue, same gap record on a failure), but says whether THIS
   *  append was written: a caller that must not promise an Undo it cannot give. Never rejects. */
  appendStrict(io: ChangeLogIo, entries: ChangeEntry[]): Promise<{ saved: boolean }>;
  /** Failed appends not yet written as a gap record. */
  pendingGaps(): ChangeGap[];
}

/**
 * One per process per writer: the companion's sync and a Telegram tap, or the
 * add-on's sync and a button, append through the SAME instance, so its queue
 * serialises their read-append-writes and no append overwrites another.
 */
export function createChangeLogWriter(opts: {
  writer: ChangeWriter;
  now?: () => Date;
  log?: (msg: string) => void;
}): ChangeLogWriter {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  let pending: ChangeGap[] = [];
  let clearedMonth: string | null = null;
  let tail: Promise<void> = Promise.resolve();

  async function clearOld(io: ChangeLogIo, month: string): Promise<void> {
    if (clearedMonth === month) return;
    let old = month;
    try {
      for (let back = CHANGE_LOG_CLEAR_MONTHS_BACK; back <= CHANGE_LOG_CLEAR_MONTHS_THROUGH; back++) {
        old = shiftMonth(month, -back);
        await io.clear(changeLogKey(opts.writer, old));
        await io.clear(changeLogKey(opts.writer, old, true));
      }
      clearedMonth = month;
    } catch (err) {
      log(`Change log: could not clear ${old}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function run(io: ChangeLogIo, entries: ChangeEntry[]): Promise<boolean> {
    if (entries.length === 0) return true;
    const at = now();
    await clearOld(io, changeMonth(at));
    try {
      await appendChanges(io.get, io.set, opts.writer, entries, at, pending);
      pending = [];
      return true;
    } catch (err) {
      const reason = err instanceof ChangeLogPausedError ? GAP_REASON_UNREADABLE : GAP_REASON_WRITE;
      const day = at.toISOString().slice(0, 10);
      const last = pending[pending.length - 1];
      if (last && last.reason === reason && last.at.slice(0, 10) === day) last.count += entries.length;
      else pending.push({ at: at.toISOString(), count: entries.length, reason });
      log(`Change log: ${entries.length} change(s) not saved (${err instanceof Error ? err.message : String(err)})`);
      return false;
    }
  }

  return {
    writer: opts.writer,
    append(io, entries) {
      const next = tail.then(() => run(io, entries)).then(() => {}, () => {});
      tail = next;
      return next;
    },
    appendStrict(io, entries) {
      const result = tail.then(() => run(io, entries)).then((saved) => ({ saved }), () => ({ saved: false }));
      tail = result.then(() => {});
      return result;
    },
    pendingGaps: () => pending.map((g) => ({ ...g })),
  };
}

// ── Reading ──────────────────────────────────────────────────────────────

export interface ChangeLogItem extends ChangeEntry {
  /** R2: set when the newest undo/redo entry reversing this one is an undo. */
  undone?: { by: string; at: string };
}

export interface ChangeLogRead {
  /** Both writers, newest first, the last 90 days. */
  entries: ChangeLogItem[];
  gaps: Array<ChangeGap & { writer: ChangeWriter }>;
  /** Entries dropped to the cap, across every bucket read. */
  trimmed: number;
  /** Buckets that could not be read (left untouched). `paused`: its fallback
   *  is unreadable too, so that writer's changes that month are not saved. */
  unreadable: Array<{ writer: ChangeWriter; month: string; paused: boolean }>;
}

/**
 * Both writers' buckets for this month and the three before it, `.2`
 * fallbacks included, merged newest first. Rejects only when the host read
 * itself fails; a corrupt bucket is reported in `unreadable`, never thrown.
 */
export async function readChangeLog(get: SecretGet, now: Date): Promise<ChangeLogRead> {
  const month = changeMonth(now);
  const months = Array.from({ length: CHANGE_LOG_READ_MONTHS }, (_, i) => shiftMonth(month, -i));
  const cutoff = now.getTime() - CHANGE_LOG_RETENTION_DAYS * 86_400_000;
  const reads = await Promise.all(months.flatMap((m) => CHANGE_LOG_WRITERS.map(async (writer) => {
    const [primary, fallback] = await Promise.all([get(changeLogKey(writer, m)), get(changeLogKey(writer, m, true))]);
    return { writer, month: m, primary: parseChangeBucket(primary, writer, m), fallback: parseChangeBucket(fallback, writer, m) };
  })));

  const entries: ChangeLogItem[] = [];
  const gaps: ChangeLogRead['gaps'] = [];
  const unreadable: ChangeLogRead['unreadable'] = [];
  let trimmed = 0;
  for (const r of reads) {
    if (r.primary.kind === 'corrupt' || r.fallback.kind === 'corrupt') {
      unreadable.push({ writer: r.writer, month: r.month, paused: r.primary.kind === 'corrupt' && r.fallback.kind === 'corrupt' });
    }
    for (const parsed of [r.primary, r.fallback]) {
      if (parsed.kind !== 'ok') continue;
      trimmed += parsed.bucket.trimmed ?? 0;
      for (const e of parsed.bucket.entries) if (Date.parse(e.at) >= cutoff) entries.push({ ...e });
      for (const g of parsed.bucket.gaps) if (Date.parse(g.at) >= cutoff) gaps.push({ ...g, writer: r.writer });
    }
  }
  entries.sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.at < b.at ? 1 : -1));
  gaps.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  // R2's undo state: the NEWEST reversing entry decides. Entries are newest
  // first, so the first one seen per target wins.
  const latest = new Map<string, ChangeEntry>();
  for (const e of entries) if (e.reverses && !latest.has(e.reverses.id)) latest.set(e.reverses.id, e);
  for (const e of entries) {
    const by = latest.get(e.id);
    if (by?.reverses?.op === 'undo') e.undone = { by: by.id, at: by.at };
  }
  return { entries, gaps, trimmed, unreadable };
}
