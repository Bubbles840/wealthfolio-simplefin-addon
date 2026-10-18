/**
 * shared/subscription-prefs.ts
 *
 * The ONE stored document behind every subscription choice: what is hidden,
 * confirmed, renamed, reminded about, and added by hand. Two writers share it
 * — the app and the Telegram bot — so every write goes through
 * `editSubscriptionPrefs`, which re-reads the stored copy immediately before
 * writing and applies one of the pure edits below. Both writers call the same
 * edits, so a tap cannot mean one thing in the app and another in the chat.
 *
 * Corrupt is not absent. A document that exists but cannot be read refuses
 * every write: treating it as empty and saving would wipe every choice.
 *
 * `hidden` and `confirmed` are also written to the two pre-1.60 settings on
 * every edit, so an older companion or a stale tab reads correct lists during
 * an upgrade. Removing that mirror is a follow-up, one release after this.
 */
import {
  CONFIRMED_SUBSCRIPTIONS_SECRET_KEY, HIDDEN_SUBSCRIPTIONS_SECRET_KEY, parseHiddenSubscriptions,
} from './subscriptions.js';
import { addPeriod, isManualKey, manualKey, normalizeDeclinedLink, normalizeRosterKey, type Cadence } from './subscription-roster.js';

export const SUBSCRIPTION_PREFS_SECRET_KEY = 'subscription_prefs';
/** Days a deleted hand-added entry is kept for ↩ Undo. */
export const DELETED_KEEP_DAYS = 7;

export type RemindDays = 1 | 3 | 7;

export interface ManualSubscription {
  /** Short random id; the roster key is `m:<id>`, linked or not. */
  id: string;
  name: string;
  cents: number;
  cadence: Cadence;
  /** YYYY-MM-DD, as entered or as set when linked; the roster rolls it forward. */
  nextDate: string;
  /** The detector's name for its charges, once linked. */
  merchant?: string;
}

export interface DeletedSubscription extends ManualSubscription { deletedAt: string }

export interface SubscriptionPrefs {
  v: 1;
  /** Roster keys. */
  hidden: string[];
  /** Detector keys counted as subscriptions whatever their tier. */
  confirmed: string[];
  /** Key → display name. */
  names: Record<string, string>;
  /** One level of history for ↩ Undo on a rename; null = there was no name. */
  prevNames: Record<string, string | null>;
  /** Key → days of warning before a charge. */
  remind: Record<string, RemindDays>;
  manual: ManualSubscription[];
  /** ↩ Undo for a delete; pruned after DELETED_KEEP_DAYS. */
  deleted: DeletedSubscription[];
  /** `${manualId}|${merchant}` — a "No" to a link suggestion sticks. */
  declinedLinks: string[];
}

export type ParsedSubscriptionPrefs =
  | { kind: 'ok'; prefs: SubscriptionPrefs }
  | { kind: 'absent' }
  | { kind: 'corrupt' };

export interface LoadedSubscriptionPrefs {
  prefs: SubscriptionPrefs;
  /** A stored document exists but cannot be read: `prefs` is then the legacy
   *  lists, for reading only, and every write is refused. */
  unreadable: boolean;
}

export type SecretGet = (key: string) => Promise<string | null>;
export type SecretSet = (key: string, value: string) => Promise<void>;
export type SubscriptionEdit = (prefs: SubscriptionPrefs) => SubscriptionPrefs;

export class SubscriptionPrefsUnreadableError extends Error {
  constructor() {
    super('subscription_prefs is unreadable; refusing to overwrite it');
    this.name = 'SubscriptionPrefsUnreadableError';
  }
}

/** The edit produced a document this module could not read back. Nothing is saved. */
export class SubscriptionPrefsInvalidError extends Error {
  constructor() {
    super('The subscription settings change was invalid — nothing was saved.');
    this.name = 'SubscriptionPrefsInvalidError';
  }
}

/** By name as well as by class: a bundle or a test double can carry its own copy of the class. */
export function isUnreadablePrefsError(err: unknown): boolean {
  return err instanceof SubscriptionPrefsUnreadableError
    || (typeof err === 'object' && err !== null
      && (err as { name?: unknown }).name === 'SubscriptionPrefsUnreadableError');
}

export function emptySubscriptionPrefs(): SubscriptionPrefs {
  return {
    v: 1, hidden: [], confirmed: [], names: {}, prevNames: {}, remind: {},
    manual: [], deleted: [], declinedLinks: [],
  };
}

/** 8 base-36 characters; `random` is injectable for tests. */
export function newManualId(random: () => number = Math.random): string {
  let id = '';
  for (let i = 0; i < 8; i += 1) id += Math.floor(random() * 36).toString(36);
  return id;
}

/** A real calendar day: the shape matches AND it survives a round trip, so 2026-02-31 is refused. */
function isIsoDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}
/** Own-property lookup. `in` and bare indexing see the prototype, so a key named 'constructor' would read Object's. */
const own = (rec: object, key: string): boolean => Object.prototype.hasOwnProperty.call(rec, key);
const INVALID = Symbol('invalid');
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
const recordOf = (v: unknown, ok: (x: unknown) => boolean): boolean => isRecord(v) && Object.values(v).every(ok);
const isRemind = (x: unknown): x is RemindDays => x === 1 || x === 3 || x === 7;

function isManual(v: unknown): v is ManualSubscription {
  if (!isRecord(v)) return false;
  return typeof v.id === 'string' && v.id !== ''
    && typeof v.name === 'string'
    && Number.isInteger(v.cents) && (v.cents as number) > 0
    && (v.cadence === 'monthly' || v.cadence === 'yearly')
    && typeof v.nextDate === 'string' && isIsoDay(v.nextDate)
    && (v.merchant === undefined || typeof v.merchant === 'string');
}

const isDeleted = (v: unknown): v is DeletedSubscription =>
  isManual(v) && typeof (v as { deletedAt?: unknown }).deletedAt === 'string';

export function parseSubscriptionPrefs(raw: string | null | undefined): ParsedSubscriptionPrefs {
  // '' is how the companion clears a secret: its API has no delete.
  if (raw === null || raw === undefined || raw.trim() === '') return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  if (!isRecord(parsed) || parsed.v !== 1) return { kind: 'corrupt' };
  const doc = parsed;
  // A missing field is its default; a present field of the wrong shape is
  // corruption — guessing there is exactly how a write wipes a choice.
  const field = <T>(name: string, ok: (x: unknown) => boolean, fallback: T): T | typeof INVALID =>
    doc[name] === undefined ? fallback : ok(doc[name]) ? (doc[name] as T) : INVALID;
  const empty = emptySubscriptionPrefs();
  const prefs = {
    v: 1 as const,
    hidden: field('hidden', isStringArray, empty.hidden),
    confirmed: field('confirmed', isStringArray, empty.confirmed),
    names: field('names', (x) => recordOf(x, (s) => typeof s === 'string'), empty.names),
    prevNames: field('prevNames', (x) => recordOf(x, (s) => s === null || typeof s === 'string'), empty.prevNames),
    remind: field('remind', (x) => recordOf(x, isRemind), empty.remind),
    manual: field('manual', (x) => Array.isArray(x) && x.every(isManual), empty.manual),
    deleted: field('deleted', (x) => Array.isArray(x) && x.every(isDeleted), empty.deleted),
    declinedLinks: field('declinedLinks', isStringArray, empty.declinedLinks),
  };
  if (Object.values(prefs).some((x) => x === INVALID)) return { kind: 'corrupt' };
  return { kind: 'ok', prefs: prefs as SubscriptionPrefs };
}

async function legacySubscriptionPrefs(get: SecretGet): Promise<SubscriptionPrefs> {
  const [hidden, confirmed] = await Promise.all([
    get(HIDDEN_SUBSCRIPTIONS_SECRET_KEY),
    get(CONFIRMED_SUBSCRIPTIONS_SECRET_KEY),
  ]);
  return { ...emptySubscriptionPrefs(), hidden: parseHiddenSubscriptions(hidden), confirmed: parseHiddenSubscriptions(confirmed) };
}

/** The document, or — while none is stored — one built from the two legacy
 *  settings, so nothing hidden or confirmed before 1.60 is lost. A failed read
 *  rejects: unreachable must never read as "nothing chosen". */
export async function loadSubscriptionPrefs(get: SecretGet): Promise<LoadedSubscriptionPrefs> {
  const parsed = parseSubscriptionPrefs(await get(SUBSCRIPTION_PREFS_SECRET_KEY));
  if (parsed.kind === 'ok') return { prefs: parsed.prefs, unreadable: false };
  return { prefs: await legacySubscriptionPrefs(get), unreadable: parsed.kind === 'corrupt' };
}

/**
 * The only write. Re-reads immediately before writing (two writers, no
 * compare-and-swap; taps are human-paced, so the residual race is accepted),
 * applies `edit`, prunes old deletions, writes, then mirrors `hidden` and
 * `confirmed` into the legacy settings. The mirror is best-effort: the
 * document is the commit, and a failed mirror must not make a saved edit
 * look failed (a retried "add" would add twice).
 */
export async function editSubscriptionPrefs(
  get: SecretGet,
  set: SecretSet,
  edit: SubscriptionEdit,
  now: Date = new Date(),
): Promise<SubscriptionPrefs> {
  const parsed = parseSubscriptionPrefs(await get(SUBSCRIPTION_PREFS_SECRET_KEY));
  if (parsed.kind === 'corrupt') throw new SubscriptionPrefsUnreadableError();
  const base = parsed.kind === 'ok' ? parsed.prefs : await legacySubscriptionPrefs(get);
  const next = pruneDeleted(edit(base), now);
  // Never write what the parser would refuse on the next read.
  const body = JSON.stringify(next);
  if (parseSubscriptionPrefs(body).kind !== 'ok') throw new SubscriptionPrefsInvalidError();
  await set(SUBSCRIPTION_PREFS_SECRET_KEY, body);
  // Each mirror write is independent: one failing must not skip the other.
  try {
    await set(HIDDEN_SUBSCRIPTIONS_SECRET_KEY, JSON.stringify(next.hidden.filter((k) => !isManualKey(k))));
  } catch {
    // Best-effort; see above.
  }
  try {
    await set(CONFIRMED_SUBSCRIPTIONS_SECRET_KEY, JSON.stringify(next.confirmed));
  } catch {
    // Best-effort; see above.
  }
  return next;
}

// R6: a key saved before 1.63 (`*8712 PAYMENT …`) is the same entry as today's
// (`PAYMENT …`); hand-added keys compare exactly (normalizeRosterKey keeps them).
const sameKey = (a: string, b: string) => a === b || normalizeRosterKey(a) === normalizeRosterKey(b);
const without = (list: string[], key: string) => list.filter((k) => !sameKey(k, key));
const withKey = (list: string[], key: string) => (list.some((k) => sameKey(k, key)) ? list : [...list, key]);

export function hideKey(p: SubscriptionPrefs, key: string): SubscriptionPrefs {
  return { ...p, hidden: withKey(p.hidden, key) };
}

export function unhideKey(p: SubscriptionPrefs, key: string): SubscriptionPrefs {
  return { ...p, hidden: without(p.hidden, key) };
}

/** Restores a roster row: its key, and each alias a hide may be stored under
 *  (F1). A renamed charge's key (`GOOGLE *G1AI101M …`) hides the entry it was
 *  joined into, so unhiding only the entry's own key left it hidden for good. */
export function unhideEntry(p: SubscriptionPrefs, entry: { key: string; aliases?: readonly string[] }): SubscriptionPrefs {
  return [entry.key, ...(entry.aliases ?? [])].reduce((acc, key) => unhideKey(acc, key), p);
}

export function confirmKey(p: SubscriptionPrefs, key: string): SubscriptionPrefs {
  return { ...p, confirmed: withKey(p.confirmed, key) };
}

export function unconfirmKey(p: SubscriptionPrefs, key: string): SubscriptionPrefs {
  return { ...p, confirmed: without(p.confirmed, key) };
}

/** Records the name it replaces (one level) for ↩ Undo. Blank changes nothing. */
export function renameKey(p: SubscriptionPrefs, key: string, name: string): SubscriptionPrefs {
  const trimmed = name.trim();
  if (trimmed === '') return p;
  // Same name as shown now: nothing changes, so the Undo history is kept.
  if (own(p.names, key) && p.names[key] === trimmed) return p;
  return {
    ...p,
    names: { ...p.names, [key]: trimmed },
    prevNames: { ...p.prevNames, [key]: own(p.names, key) ? p.names[key] : null },
  };
}

export function undoRename(p: SubscriptionPrefs, key: string): SubscriptionPrefs {
  if (!own(p.prevNames, key)) return p;
  const prev = p.prevNames[key];
  const names = { ...p.names };
  if (prev === null) delete names[key];
  else names[key] = prev;
  const prevNames = { ...p.prevNames };
  delete prevNames[key];
  return { ...p, names, prevNames };
}

export function setRemind(p: SubscriptionPrefs, key: string, days: RemindDays | null): SubscriptionPrefs {
  const remind = { ...p.remind };
  if (days === null) delete remind[key];
  else remind[key] = days;
  return { ...p, remind };
}

export function addManual(p: SubscriptionPrefs, entry: ManualSubscription): SubscriptionPrefs {
  return { ...p, manual: [...p.manual.filter((m) => m.id !== entry.id), entry] };
}

export function updateManual(
  p: SubscriptionPrefs,
  id: string,
  patch: Partial<Pick<ManualSubscription, 'name' | 'cents' | 'cadence' | 'nextDate'>>,
): SubscriptionPrefs {
  return { ...p, manual: p.manual.map((m) => (m.id === id ? { ...m, ...patch } : m)) };
}

export function deleteManual(p: SubscriptionPrefs, id: string, now: Date): SubscriptionPrefs {
  const entry = p.manual.find((m) => m.id === id);
  if (!entry) return p;
  return {
    ...p,
    manual: p.manual.filter((m) => m.id !== id),
    deleted: [...p.deleted.filter((d) => d.id !== id), { ...entry, deletedAt: now.toISOString() }],
  };
}

export function restoreDeleted(p: SubscriptionPrefs, id: string): SubscriptionPrefs {
  const entry = p.deleted.find((d) => d.id === id);
  if (!entry) return p;
  const { deletedAt: _deletedAt, ...manual } = entry;
  return {
    ...p,
    deleted: p.deleted.filter((d) => d.id !== id),
    manual: [...p.manual.filter((m) => m.id !== id), manual],
  };
}

/** "Yes, HULU is my Hulu": the entry takes the merchant, its next date becomes
 *  the charge + one period, and a hide or reminder the user had set on the
 *  merchant moves to the hand-added key (its own reminder wins). */
export function acceptLink(
  p: SubscriptionPrefs,
  link: { manualId: string; merchant: string; date: string },
): SubscriptionPrefs {
  const entry = p.manual.find((m) => m.id === link.manualId);
  if (!entry) return p;
  const key = manualKey(entry.id);
  const hidden = p.hidden.some((k) => sameKey(k, link.merchant)) ? withKey(without(p.hidden, link.merchant), key) : p.hidden;
  const remind = { ...p.remind };
  if (own(remind, link.merchant)) {
    if (!own(remind, key)) remind[key] = remind[link.merchant];
    delete remind[link.merchant];
  }
  return {
    ...p,
    hidden,
    remind,
    manual: p.manual.map((m) => (m.id === entry.id
      ? { ...m, merchant: link.merchant, nextDate: addPeriod(link.date, m.cadence) }
      : m)),
  };
}

export function declineLink(p: SubscriptionPrefs, manualId: string, merchant: string): SubscriptionPrefs {
  // Not withKey: that would normalize the whole `id|merchant` string.
  const entry = `${manualId}|${merchant}`;
  const probe = normalizeDeclinedLink(entry);
  if (p.declinedLinks.some((l) => normalizeDeclinedLink(l) === probe)) return p;
  return { ...p, declinedLinks: [...p.declinedLinks, entry] };
}

/** Drops tombstones older than DELETED_KEEP_DAYS, with every name, reminder,
 *  hide and declined link keyed to them. */
export function pruneDeleted(p: SubscriptionPrefs, now: Date): SubscriptionPrefs {
  const cutoff = now.getTime() - DELETED_KEEP_DAYS * 86_400_000;
  const gone = p.deleted.filter((d) => !(Date.parse(d.deletedAt) >= cutoff));
  if (gone.length === 0) return p;
  const goneIds = new Set(gone.map((d) => d.id));
  const goneKeys = new Set(gone.map((d) => manualKey(d.id)));
  const dropKeys = <T>(rec: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(rec).filter(([k]) => !goneKeys.has(k)));
  return {
    ...p,
    deleted: p.deleted.filter((d) => !goneIds.has(d.id)),
    hidden: p.hidden.filter((k) => !goneKeys.has(k)),
    names: dropKeys(p.names),
    prevNames: dropKeys(p.prevNames),
    remind: dropKeys(p.remind),
    declinedLinks: p.declinedLinks.filter((x) => !goneIds.has(x.split('|')[0])),
  };
}
