/**
 * shared/sync-overrides.ts
 *
 * What the person told the sync NOT to do again: the document an Undo of a
 * sync decision writes, and every sync — the add-on's and the companion's —
 * reads before it decides anything. Undo records the override; the sync
 * applies it. Without it, the next sync would simply make the same decision
 * again.
 *
 * Per transaction (`tx`, keyed by `accountTxKey`, so a shared SimpleFin id in
 * two accounts stays two entries):
 *  - `notTransfer`   never paired or linked; keywords and mapping rules do not
 *                    type it as a transfer; a linked pair with such a leg is
 *                    unlinked on the next sync.
 *  - `keepDuplicate` the duplicate prune leaves its copies.
 *  - `noAutoFile`    the Amazon filer leaves it.
 *  - `noAmazonLabel` no Amazon label is added to its note.
 * Per SimpleFin account (`accounts`):
 *  - `noAutoCorrect` no automatic balance correction (drift is still reported).
 *  - `noOpeningFile` the card opening-balance filer leaves its opening balance.
 *
 * Two writers share it (the app and the bot), so every write goes through
 * `editSyncOverrides`, which re-reads immediately before writing and applies
 * one of the pure edits below — the same safety as `subscription_prefs`.
 *
 * Corrupt is not absent. A stored document that cannot be read is never
 * overwritten (every write is refused) and the sync treats it as empty, which
 * is exactly how it behaved before overrides existed.
 */
import type { SecretGet, SecretSet } from './subscription-prefs.js';

export const SYNC_OVERRIDES_SECRET_KEY = 'sync_overrides';
/** Transaction overrides older than this are dropped on the next write. */
export const TX_OVERRIDE_KEEP_DAYS = 365;

export const TX_OVERRIDE_FLAGS = ['notTransfer', 'keepDuplicate', 'noAutoFile', 'noAmazonLabel'] as const;
export type TxOverrideFlag = (typeof TX_OVERRIDE_FLAGS)[number];
export const ACCOUNT_OVERRIDE_FLAGS = ['noAutoCorrect', 'noOpeningFile'] as const;
export type AccountOverrideFlag = (typeof ACCOUNT_OVERRIDE_FLAGS)[number];

export interface TxOverride {
  notTransfer?: true;
  keepDuplicate?: true;
  noAutoFile?: true;
  noAmazonLabel?: true;
  /** When it was last set (ISO). */
  at: string;
  /** The change-log entry whose undo set it. */
  entryId?: string;
  /** What it is, in words ("CITI AUTOPAY · Checking"), for the overrides list —
   *  the change log keeps 90 days, an override a year. */
  label?: string;
}

export interface AccountOverride {
  noAutoCorrect?: true;
  noOpeningFile?: true;
  at: string;
  /** The account's name, for the overrides list. */
  label?: string;
}

export interface SyncOverrides {
  v: 1;
  tx: Record<string, TxOverride>;
  accounts: Record<string, AccountOverride>;
}

export type ParsedSyncOverrides =
  | { kind: 'ok'; overrides: SyncOverrides }
  | { kind: 'absent' }
  | { kind: 'corrupt' };

export interface LoadedSyncOverrides {
  overrides: SyncOverrides;
  /** A stored document exists but cannot be read: `overrides` is empty and
   *  every write is refused. */
  unreadable: boolean;
}

export type SyncOverridesEdit = (o: SyncOverrides) => SyncOverrides;

export const SYNC_OVERRIDES_UNREADABLE_MESSAGE = "Your sync overrides can't be read, so nothing was changed.";

export class SyncOverridesUnreadableError extends Error {
  constructor() {
    super(SYNC_OVERRIDES_UNREADABLE_MESSAGE);
    this.name = 'SyncOverridesUnreadableError';
  }
}

/** The edit produced a document this module could not read back. Nothing is saved. */
export class SyncOverridesInvalidError extends Error {
  constructor() {
    super('That override was invalid — nothing was saved.');
    this.name = 'SyncOverridesInvalidError';
  }
}

/** By name as well as by class: a bundle or a test double can carry its own copy of the class. */
export function isUnreadableOverridesError(err: unknown): boolean {
  return err instanceof SyncOverridesUnreadableError
    || (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'SyncOverridesUnreadableError');
}

export function emptySyncOverrides(): SyncOverrides {
  return { v: 1, tx: {}, accounts: {} };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Own-property lookup: `in` and bare indexing see the prototype. */
const own = (rec: object, key: string): boolean => Object.prototype.hasOwnProperty.call(rec, key);
const isIso = (x: unknown): x is string => typeof x === 'string' && !Number.isNaN(Date.parse(x));

/** Every key known and well-shaped; a flag is only ever `true`. An unknown key
 *  is corruption: a newer document shape needs `v: 2`, or an older writer would
 *  drop what it does not know on its next write. */
function isEntry(v: unknown, flags: readonly string[]): boolean {
  if (!isRecord(v) || !isIso(v.at)) return false;
  return Object.entries(v).every(([k, x]) => {
    if (flags.includes(k)) return x === true;
    if (k === 'at') return true;
    if (k === 'entryId' || k === 'label') return typeof x === 'string';
    return false;
  });
}

export function parseSyncOverrides(raw: string | null | undefined): ParsedSyncOverrides {
  // '' is how the companion clears a secret: its API has no delete.
  if (raw === null || raw === undefined || raw.trim() === '') return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  if (!isRecord(parsed) || parsed.v !== 1) return { kind: 'corrupt' };
  if (Object.keys(parsed).some((k) => k !== 'v' && k !== 'tx' && k !== 'accounts')) return { kind: 'corrupt' };
  const tx = parsed.tx === undefined ? {} : parsed.tx;
  const accounts = parsed.accounts === undefined ? {} : parsed.accounts;
  if (!isRecord(tx) || !Object.values(tx).every((e) => isEntry(e, TX_OVERRIDE_FLAGS))) return { kind: 'corrupt' };
  if (!isRecord(accounts) || !Object.values(accounts).every((e) => isEntry(e, ACCOUNT_OVERRIDE_FLAGS))) return { kind: 'corrupt' };
  return {
    kind: 'ok',
    overrides: {
      v: 1,
      tx: Object.fromEntries(Object.entries(tx)) as Record<string, TxOverride>,
      accounts: Object.fromEntries(Object.entries(accounts)) as Record<string, AccountOverride>,
    },
  };
}

/** The document for a screen that edits it. A failed read rejects: unreachable
 *  must never read as "no overrides". */
export async function loadSyncOverrides(get: SecretGet): Promise<LoadedSyncOverrides> {
  const parsed = parseSyncOverrides(await get(SYNC_OVERRIDES_SECRET_KEY));
  if (parsed.kind === 'ok') return { overrides: parsed.overrides, unreadable: false };
  return { overrides: emptySyncOverrides(), unreadable: parsed.kind === 'corrupt' };
}

/** What a sync obeys. Absent, corrupt and unreadable all read as empty — the
 *  sync then behaves exactly as it did before overrides existed. */
export async function syncOverridesOrEmpty(get: SecretGet): Promise<SyncOverrides> {
  try {
    return (await loadSyncOverrides(get)).overrides;
  } catch {
    return emptySyncOverrides();
  }
}

/**
 * The only write. Re-reads immediately before writing (two writers, no
 * compare-and-swap; taps are human-paced, so the residual race is accepted),
 * applies `edit`, drops year-old transaction entries, and refuses to write a
 * document the parser would reject.
 */
export async function editSyncOverrides(
  get: SecretGet,
  set: SecretSet,
  edit: SyncOverridesEdit,
  now: Date = new Date(),
): Promise<SyncOverrides> {
  const parsed = parseSyncOverrides(await get(SYNC_OVERRIDES_SECRET_KEY));
  if (parsed.kind === 'corrupt') throw new SyncOverridesUnreadableError();
  const base = parsed.kind === 'ok' ? parsed.overrides : emptySyncOverrides();
  const next = pruneTxOverrides(edit(base), now);
  const body = JSON.stringify(next);
  if (parseSyncOverrides(body).kind !== 'ok') throw new SyncOverridesInvalidError();
  await set(SYNC_OVERRIDES_SECRET_KEY, body);
  return next;
}

/** A record with one key replaced or removed, built with `Object.fromEntries`
 *  so no key — however odd — can reach the prototype. */
function withKey<T>(rec: Record<string, T>, key: string, value: T | null): Record<string, T> {
  const rest = Object.entries(rec).filter(([k]) => k !== key);
  return Object.fromEntries(value === null ? rest : [...rest, [key, value]]);
}

const hasAnyFlag = (entry: object, flags: readonly string[]) => flags.some((f) => own(entry, f));

export function setTxOverride(
  o: SyncOverrides,
  txKey: string,
  flag: TxOverrideFlag,
  now: Date,
  extra: { entryId?: string; label?: string } = {},
): SyncOverrides {
  const prev = own(o.tx, txKey) ? o.tx[txKey] : undefined;
  const entry: TxOverride = {
    ...(prev ?? {}),
    [flag]: true,
    at: now.toISOString(),
    ...(extra.entryId ? { entryId: extra.entryId } : {}),
    ...(extra.label ? { label: extra.label } : {}),
  };
  return { ...o, tx: withKey(o.tx, txKey, entry) };
}

/** Clears one flag; the entry goes when no flag is left. */
export function clearTxOverride(o: SyncOverrides, txKey: string, flag: TxOverrideFlag): SyncOverrides {
  if (!own(o.tx, txKey)) return o;
  const { [flag]: _gone, ...rest } = o.tx[txKey];
  return { ...o, tx: withKey(o.tx, txKey, hasAnyFlag(rest, TX_OVERRIDE_FLAGS) ? (rest as TxOverride) : null) };
}

export function setAccountOverride(
  o: SyncOverrides,
  sfinId: string,
  flag: AccountOverrideFlag,
  now: Date,
  extra: { label?: string } = {},
): SyncOverrides {
  const prev = own(o.accounts, sfinId) ? o.accounts[sfinId] : undefined;
  const entry: AccountOverride = {
    ...(prev ?? {}),
    [flag]: true,
    at: now.toISOString(),
    ...(extra.label ? { label: extra.label } : {}),
  };
  return { ...o, accounts: withKey(o.accounts, sfinId, entry) };
}

export function clearAccountOverride(o: SyncOverrides, sfinId: string, flag: AccountOverrideFlag): SyncOverrides {
  if (!own(o.accounts, sfinId)) return o;
  const { [flag]: _gone, ...rest } = o.accounts[sfinId];
  return { ...o, accounts: withKey(o.accounts, sfinId, hasAnyFlag(rest, ACCOUNT_OVERRIDE_FLAGS) ? (rest as AccountOverride) : null) };
}

/** Drops transaction entries set more than a year ago. Account switches stay
 *  until they are changed. */
export function pruneTxOverrides(o: SyncOverrides, now: Date): SyncOverrides {
  const cutoff = now.getTime() - TX_OVERRIDE_KEEP_DAYS * 86_400_000;
  const kept = Object.entries(o.tx).filter(([, e]) => Date.parse(e.at) >= cutoff);
  if (kept.length === Object.keys(o.tx).length) return o;
  return { ...o, tx: Object.fromEntries(kept) };
}

export function hasTxOverride(o: SyncOverrides, txKey: string, flag: TxOverrideFlag): boolean {
  return own(o.tx, txKey) && o.tx[txKey][flag] === true;
}

export function hasAccountOverride(o: SyncOverrides, sfinId: string, flag: AccountOverrideFlag): boolean {
  return own(o.accounts, sfinId) && o.accounts[sfinId][flag] === true;
}

/** What each override means, in the words the overrides list uses. */
export const OVERRIDE_FLAG_WORDS: Record<TxOverrideFlag | AccountOverrideFlag, string> = {
  notTransfer: 'Not a transfer',
  keepDuplicate: 'Keep both copies',
  noAutoFile: "Don't file automatically",
  noAmazonLabel: 'No Amazon label',
  noAutoCorrect: 'No automatic balance corrections',
  noOpeningFile: "Don't file the opening balance",
};

export interface OverrideRow {
  scope: 'tx' | 'account';
  /** The `tx` key or the SimpleFin account id. */
  key: string;
  flag: TxOverrideFlag | AccountOverrideFlag;
  /** `Not a transfer: CITI AUTOPAY · Checking`. Raw text. */
  text: string;
  at: string;
}

/** One row per flag, newest first — what the app's "Your overrides" lists. An
 *  entry without a label names its transaction id (the part of the key after
 *  the account) or its account id. */
export function overrideRows(o: SyncOverrides): OverrideRow[] {
  const rows: OverrideRow[] = [];
  for (const [key, e] of Object.entries(o.tx)) {
    const name = e.label ?? key.slice(key.indexOf('\u0000') + 1);
    for (const flag of TX_OVERRIDE_FLAGS) {
      if (e[flag]) rows.push({ scope: 'tx', key, flag, text: `${OVERRIDE_FLAG_WORDS[flag]}: ${name}`, at: e.at });
    }
  }
  for (const [key, e] of Object.entries(o.accounts)) {
    const name = e.label ?? key;
    for (const flag of ACCOUNT_OVERRIDE_FLAGS) {
      if (e[flag]) rows.push({ scope: 'account', key, flag, text: `${OVERRIDE_FLAG_WORDS[flag]}: ${name}`, at: e.at });
    }
  }
  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.text.localeCompare(b.text)));
}

/** The edit that removes one listed override (the list's Remove button). */
export function removeOverrideRow(o: SyncOverrides, row: Pick<OverrideRow, 'scope' | 'key' | 'flag'>): SyncOverrides {
  return row.scope === 'tx'
    ? clearTxOverride(o, row.key, row.flag as TxOverrideFlag)
    : clearAccountOverride(o, row.key, row.flag as AccountOverrideFlag);
}
