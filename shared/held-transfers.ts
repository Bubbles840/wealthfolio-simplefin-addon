/**
 * 1.65 C (issue #13): one judgement of a long-held in-transit transfer, shared
 * by the companion's daily finding and the app's Checks. It names the real
 * reason a leg is still held — the connected account whose feed has not yet
 * caught up — using exactly the rule the sync's expiry applies
 * (`expiryHoldAccount`), fed from what the sync stored.
 *
 * Must not be imported by sync-core.ts: it imports sync-core.ts.
 */
import { bankDayInstant } from './bank-day.js';
import { accountNameWords, expiryHoldAccount } from './sync-core.js';
import { formatDollars } from './telegram.js';
import { accountTxKey } from './transfers.js';
import { sfinIdsFor } from './tx-story.js';

/** A transfer held at least this long is worth saying something about. */
export const HELD_MIN_AGE_DAYS = 14;

/** What the sync stored: account_mapping (SimpleFin id → Wealthfolio id),
 *  account_balances, account_names (SimpleFin id → name). A stored figure that
 *  is not a finite number counts as no life. */
export interface StoredFeeds {
  mapping: Readonly<Record<string, string>>;
  balances: Readonly<Record<string, { date?: unknown; aliveThrough?: unknown } | null | undefined>>;
  names: Readonly<Record<string, string>>;
}

export interface HeldRow {
  id: string;
  description: string;
  amount: number;
  ageDays: number;
  wfAccountId?: string;
  date?: string;
  txId?: string | null;
  direction?: 'in' | 'out';
}

export interface HeldTransfer {
  activityId: string;
  description: string;
  amount: number;
  ageDays: number;
  direction: 'in' | 'out';
  /** The holding account's name ("another account" when none is stored);
   *  null = no feed holds it (the next sync settles it); ABSENT = cannot tell. */
  heldBy?: string | null;
  txKey: string | null;
  label: string;
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const isObj = (v: unknown): v is object => typeof v === 'object' && v !== null;

/** The leg's own SimpleFin account: the one mapped feed in the last download,
 *  else the only mapped one; null when it cannot be told (a reissued card with
 *  two feeds both present). */
function ownFeedId(feeds: StoredFeeds, wfAccountId: string): string | null {
  const candidates = sfinIdsFor(feeds.mapping as Record<string, string>, wfAccountId);
  const present = candidates.filter((id) => isObj(feeds.balances[id]));
  if (present.length === 1) return present[0];
  if (present.length === 0 && candidates.length === 1) return candidates[0];
  return null;
}

export function judgeHeldTransfer(row: HeldRow, feeds: StoredFeeds | undefined, now: Date): HeldTransfer {
  const sfinId = feeds && row.wfAccountId ? ownFeedId(feeds, row.wfAccountId) : null;
  const own = feeds && sfinId ? feeds.names[sfinId] : undefined;
  const base: HeldTransfer = {
    activityId: row.id,
    description: row.description,
    amount: row.amount,
    ageDays: row.ageDays,
    direction: row.direction ?? 'out',
    txKey: sfinId && row.txId ? accountTxKey(sfinId, row.txId) : null,
    label: own ? `${row.description} · ${own}` : row.description,
  };
  // Unusable stored balances for the leg's own account: cannot tell why.
  if (!feeds || !sfinId || !row.date || !isObj(feeds.balances[sfinId])) return base;

  // Mirrors the sync: only an account that was in the last download has life
  // and name words; any other mapped account has neither, so it holds every leg.
  const mappedIds = Object.keys(feeds.mapping);
  const alive = new Map<string, number>();
  const nameWords = new Map<string, readonly string[]>();
  for (const id of mappedIds) {
    const b = feeds.balances[id];
    if (!isObj(b)) continue;
    const bal = b as { date?: unknown; aliveThrough?: unknown };
    alive.set(id, finite(bal.aliveThrough) ?? finite(bal.date) ?? 0);
    nameWords.set(id, accountNameWords(feeds.names[id] ?? ''));
  }
  const holder = expiryHoldAccount(sfinId, Date.parse(bankDayInstant(row.date)) / 1000, mappedIds, alive, {
    nowSec: Math.floor(now.getTime() / 1000), legDescription: row.description, nameWords,
  });
  return { ...base, heldBy: holder === null ? null : feeds.names[holder] ?? 'another account' };
}

export function heldTransferMessage(h: HeldTransfer): string {
  const head = `${h.description} (${formatDollars(Math.abs(h.amount), 2)}) has waited ${h.ageDays} days for its other half`;
  if (h.heldBy === undefined) return head;
  if (h.heldBy === null) return `${head} — the next sync settles it`;
  return `${head} — ${h.heldBy}'s feed is behind, so it stays on hold`;
}
