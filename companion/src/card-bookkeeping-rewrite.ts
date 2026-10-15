/**
 * companion/src/card-bookkeeping-rewrite.ts
 *
 * Once, on Wealthfolio 3.10 or newer (1.62.0, U4): every bookkeeping outflow
 * the sync wrote on a credit card as a WITHDRAWAL — an opening debt, a balance
 * plug, an in-transit placeholder, known by its note — becomes a TRANSFER_OUT
 * marked external. 3.8 and 3.9 refused TRANSFER_OUT on a card (v1.55), so
 * those rows had to be WITHDRAWALs, which Wealthfolio's Spending page counts.
 * 3.10 takes one (upstream #1796) and ignores an unlinked one; the external
 * marker keeps Health from calling it an incomplete transfer. Same amount,
 * same instant, same note: the balance does not move, and the sync's readers
 * still know each row by its note.
 *
 * - Runs once: a secret records that it finished, and it never runs again.
 * - Gated: on 3.9 or an unknown version it does nothing and marks nothing.
 * - Resumable: rows are written in batches; a batch that fails stops the
 *   run unmarked, and the next sync finds what is still a WITHDRAWAL.
 * - Leaves alone: a row in a group (Wealthfolio copies an update onto a
 *   linked partner), a row whose type you overrode in Wealthfolio, and a row
 *   carrying a REAL security asset (a transfer with one books no cash).
 * - The phantom "$CASH" asset: 3.8 and 3.9 minted a "$CASH" security for every
 *   REST row sent with `$CASH-USD` (upstream #1335), and the sync wrote card
 *   WITHDRAWALs that way since v1.55. Such a row is rewritten too, sent with
 *   `symbol: $CASH-<ccy>`: 3.10 (4d1f6b25a) clears an updated row's asset when
 *   it only names a cash symbol. Without it the TRANSFER_OUT would keep a
 *   security and 3.10 would refuse it on a card.
 * - Never trusts a stale read: the database is opened live only (never the
 *   immutable snapshot, which can be days old), and each batch is re-read by id
 *   over REST; every write is built from that fresh row (its instant, its
 *   note) and carries no amount or fee (3.10 keeps an omitted decimal).
 * - Respects choices: a starting balance whose account has `noOpeningFile`, a
 *   row filed under a category the sync did not make, and a row with split
 *   lines (3.10 deletes them when the type changes) are left alone, logged.
 * - Finishes past a refusal (3.10's bulk write is all or nothing): a refused
 *   batch is retried row by row, a row refused alone is retried once at the
 *   end, and a row refused twice is left for good (logged, listed in the
 *   entry). Only a temporary failure (5xx, network, 408, 423, 429) stops the
 *   run unmarked.
 * - Waits for the 1.62 add-on: an older one keeps writing WITHDRAWALs.
 * - One bookkeeping entry in the change log per run that wrote anything.
 *
 * Reads the database read-only; writes through the REST bulk endpoint.
 */
import { existsSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { bookkeepingChange, type ChangeDraft } from '../../shared/change-entries.js';
import {
  BALANCE_ADJUSTMENT_COMMENT_PREFIX, EXTERNAL_BOOKKEEPING_METADATA, IN_TRANSIT_COMMENT_PREFIX, STARTING_BALANCE_COMMENT_PREFIX,
} from '../../shared/sync-core.js';
import type { ActivityWrite, SaveManyRequest, SaveManyResult } from '../../shared/sync-host.js';
import { hostTakesCardTransferOut, isNewerVersion } from '../../shared/version.js';
import { PHANTOM_CASH_ASSET_ID } from './sqlite-audit.js';

/** The secret that says the rewrite finished (an ISO timestamp). */
export const CARD_REWRITE_SECRET_KEY = 'card_bookkeeping_rewrite';
/** Rows per bulk request. */
export const CARD_REWRITE_BATCH = 50;

/** The add-on that no longer writes card WITHDRAWAL bookkeeping. */
export const CARD_REWRITE_ADDON_SINCE = '1.62.0';
/** Categories the sync itself files its bookkeeping under; any other is the person's. */
const OWN_FILINGS = ['Opening balances', 'Sync bookkeeping'];

/** A row as Wealthfolio's search answers it now. */
export interface RewriteRestRow {
  id: string; accountId: string; activityType: string;
  /** The stored instant, as the search returns it. */
  date: string;
  comment: string | null;
  sourceGroupId?: string | null;
}

export interface CardRewriteDeps {
  dbPath: string;
  /** Wealthfolio's version (`GET /app/info`); null when unknown. */
  wealthfolioVersion: string | null;
  marker: { get(): Promise<string | null>; set(value: string): Promise<void> };
  saveMany(req: SaveManyRequest): Promise<SaveManyResult>;
  /** These rows by id, as Wealthfolio's search returns them now (a vanished id is absent). Throws when unreachable. */
  searchByIds(ids: string[]): Promise<RewriteRestRow[]>;
  /** The installed add-on's version; null when absent or unreadable (then the rewrite runs). */
  installedAddonVersion(): string | null;
  /** True for a SimpleFin account whose opening-balance filing the person undid (`noOpeningFile`). */
  noOpeningFile?(sfinAccountId: string): boolean;
  /** The change log: one draft per run that wrote anything. */
  record?(draft: ChangeDraft): void;
  log(message: string): void;
  now: Date;
}

export type CardRewriteOutcome =
  | { kind: 'done-before' }
  | { kind: 'older-host' }
  | { kind: 'old-addon' }
  | { kind: 'no-database' }
  | { kind: 'done'; rewritten: number; left: number }
  | { kind: 'stopped'; rewritten: number; why: string };

interface Row {
  id: string; account_id: string; activity_date: string; amount: string; currency: string; notes: string;
  grp: string; asset_id: string; override: string;
  /** The stored asset's display code / instrument symbol / name; '' when the asset row is missing. */
  asset_codes: string;
  asset_label: string;
  /** Names of the spending categories it is filed under (taxonomy spending_categories). */
  filings: string[];
  has_splits: boolean;
}

/** `$CASH-USD`, `CASH:USD`, …: a cash placeholder, as upstream's `is_cash_symbol` reads one. */
const isCashSymbol = (s: string) => /^\$?CASH[-_:][A-Z]{3}$/i.test(s.trim());
/** What 3.8 and 3.9 minted for `$CASH-USD`: the symbol is stored without its currency. */
const isPhantomCashCode = (s: string) => s.trim().toUpperCase() === '$CASH' || isCashSymbol(s);

/** How a row's stored asset reads. */
type AssetKind = 'none' | 'cash-id' | 'phantom' | 'security';
function assetKind(r: Row): AssetKind {
  if (!r.asset_id) return 'none';
  if (isCashSymbol(r.asset_id)) return 'cash-id';
  if (r.asset_id === PHANTOM_CASH_ASSET_ID) return 'phantom';
  const codes = r.asset_codes ? r.asset_codes.split('\u001f') : [];
  return codes.length > 0 && codes.some(isPhantomCashCode) ? 'phantom' : 'security';
}

/** Live reads only: the immutable rung can serve a days-old snapshot of a database in use. */
function open(dbPath: string): DatabaseSync | null {
  if (!dbPath || !existsSync(dbPath)) return null;
  for (const uri of [`file:${dbPath}?mode=ro`, `file:${dbPath}?mode=ro&readonly_shm=1`]) {
    try {
      const db = new DatabaseSync(uri);
      db.prepare('SELECT 1').get();
      return db;
    } catch {
      /* next form */
    }
  }
  return null;
}

const hasTable = (db: DatabaseSync, name: string) =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

function cardWithdrawals(db: DatabaseSync): Row[] {
  const rows = db.prepare(
    `SELECT a.id, a.account_id, COALESCE(a.activity_date,'') activity_date, COALESCE(a.amount,'0') amount,
            COALESCE(a.currency,'') currency, COALESCE(a.notes,'') notes, TRIM(COALESCE(a.source_group_id,'')) grp,
            TRIM(COALESCE(a.asset_id,'')) asset_id, TRIM(COALESCE(a.activity_type_override,'')) override,
            COALESCE(s.display_code,'') || char(31) || COALESCE(s.instrument_symbol,'') || char(31) || COALESCE(s.name,'') asset_codes,
            COALESCE(NULLIF(s.display_code,''), NULLIF(s.instrument_symbol,''), s.name, '') asset_label
     FROM activities a JOIN accounts acc ON a.account_id = acc.id
     LEFT JOIN assets s ON s.id = a.asset_id
     WHERE UPPER(acc.account_type) = 'CREDIT_CARD'
       AND COALESCE(acc.is_archived, 0) = 0
       AND UPPER(a.activity_type) = 'WITHDRAWAL'
       AND (COALESCE(a.notes,'') LIKE ? || '%' OR COALESCE(a.notes,'') LIKE ? || '%' OR COALESCE(a.notes,'') LIKE ? || '%')
     ORDER BY a.activity_date, a.id`,
  ).all(STARTING_BALANCE_COMMENT_PREFIX, BALANCE_ADJUSTMENT_COMMENT_PREFIX, IN_TRANSIT_COMMENT_PREFIX) as unknown as Omit<Row, 'filings' | 'has_splits'>[];
  const filings = new Map<string, string[]>();
  if (hasTable(db, 'activity_taxonomy_assignments') && hasTable(db, 'taxonomy_categories')) {
    for (const f of db.prepare(
      `SELECT ata.activity_id id, COALESCE(tc.name,'') name FROM activity_taxonomy_assignments ata
       JOIN taxonomy_categories tc ON ata.category_id = tc.id WHERE tc.taxonomy_id = 'spending_categories'`,
    ).all() as unknown as Array<{ id: string; name: string }>) filings.set(f.id, [...(filings.get(f.id) ?? []), f.name]);
  }
  const splits = new Set<string>();
  if (hasTable(db, 'spending_activity_splits')) {
    for (const r of db.prepare(`SELECT DISTINCT activity_id id FROM spending_activity_splits`).all() as unknown as Array<{ id: string }>) splits.add(r.id);
  }
  return rows.map((r) => ({ ...r, filings: filings.get(r.id) ?? [], has_splits: splits.has(r.id) }));
}

const BOOKKEEPING_PREFIXES = [STARTING_BALANCE_COMMENT_PREFIX, BALANCE_ADJUSTMENT_COMMENT_PREFIX, IN_TRANSIT_COMMENT_PREFIX];

/** A thrown write error that is the row's own fault and will not heal: only a 400 or a 422. Any other 4xx (a 401, 403, 404, 409 …) is the host's or the moment's, so the run stops unmarked. */
function isPermanent(e: unknown): boolean {
  const m = /failed: (\d{3})/.exec(e instanceof Error ? e.message : String(e));
  return !!m && [400, 422].includes(Number(m[1]));
}

/** Built from the FRESH row: its stored instant verbatim (a date-only value would move the row) and its note. No amount, no fee: 3.10 keeps an omitted decimal. */
const transferOut = (r: Row, fresh: RewriteRestRow): ActivityWrite => ({
  id: r.id,
  accountId: fresh.accountId || r.account_id,
  activityType: 'TRANSFER_OUT',
  activityDate: fresh.date,
  currency: r.currency,
  comment: fresh.comment ?? '',
  metadata: EXTERNAL_BOOKKEEPING_METADATA,
  // A phantom "$CASH" asset is cleared by naming the cash symbol (3.10+).
  ...(assetKind(r) === 'phantom' ? { symbol: { symbol: `$CASH-${(r.currency || 'USD').toUpperCase()}` } } : {}),
});

export async function rewriteCardBookkeeping(deps: CardRewriteDeps): Promise<CardRewriteOutcome> {
  if (await deps.marker.get()) return { kind: 'done-before' };
  if (!hostTakesCardTransferOut(deps.wealthfolioVersion)) return { kind: 'older-host' };
  const installed = deps.installedAddonVersion();
  if (installed && installed !== CARD_REWRITE_ADDON_SINCE && !isNewerVersion(installed, CARD_REWRITE_ADDON_SINCE)) {
    deps.log('Card bookkeeping rewrite waits for the 1.62 add-on.');
    return { kind: 'old-addon' };
  }
  const db = deps.dbPath && existsSync(deps.dbPath) ? open(deps.dbPath) : null;
  if (!db) {
    deps.log(deps.dbPath && existsSync(deps.dbPath)
      ? 'Card bookkeeping rewrite waits for a live database read.'
      : 'Card bookkeeping rewrite skipped: no Wealthfolio database to read.');
    return { kind: 'no-database' };
  }
  let rows: Row[];
  try {
    rows = cardWithdrawals(db);
  } finally {
    db.close();
  }

  const left: Row[] = [];
  const todo: Row[] = [];
  const leave = (r: Row, why: string) => {
    left.push(r);
    deps.log(`Card bookkeeping rewrite: left ${r.id} as a WITHDRAWAL — ${why}.`);
  };
  for (const r of rows) {
    if (r.grp) leave(r, 'it is in a transfer group');
    else if (r.override) leave(r, `you typed it ${r.override} in Wealthfolio`);
    else if (assetKind(r) === 'security') leave(r, `it carries a security (${r.asset_label || r.asset_id})`);
    else if (r.has_splits) leave(r, 'it has split lines, which Wealthfolio deletes when the type changes');
    else if (r.filings.some((n) => !OWN_FILINGS.includes(n))) leave(r, `you filed it under ${r.filings.filter((n) => !OWN_FILINGS.includes(n)).join(', ')}`);
    else if (r.notes.startsWith(STARTING_BALANCE_COMMENT_PREFIX) && deps.noOpeningFile?.(r.notes.slice(STARTING_BALANCE_COMMENT_PREFIX.length))) {
      leave(r, 'you undid its opening-balance filing');
    } else todo.push(r);
  }

  const done: string[] = [];
  const refused: string[] = [];
  let stopped: string | null = null;
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  /** One bulk write: 'ok', 'refused' (+ Wealthfolio's words), or 'temporary'. */
  const write = async (writes: ActivityWrite[]): Promise<{ r: 'ok' } | { r: 'refused' | 'temporary'; why: string }> => {
    try {
      const res = await deps.saveMany({ updates: writes });
      return res.errors.length > 0 ? { r: 'refused', why: res.errors.map((e) => `${e.action}: ${e.message}`).join('; ') } : { r: 'ok' };
    } catch (e) {
      return { r: isPermanent(e) ? 'refused' : 'temporary', why: message(e) };
    }
  };

  /** A row alone: ok, or refused for now (kept with the words), or the run's temporary stop. */
  const alone = async (row: Row, w: ActivityWrite): Promise<'ok' | 'refused' | 'stop'> => {
    const one = await write([w]);
    if (one.r === 'ok') { done.push(row.id); return 'ok'; }
    if (one.r === 'temporary') { stopped = one.why; return 'stop'; }
    deps.log(`Card bookkeeping rewrite: Wealthfolio refused ${row.id} (${one.why}).`);
    return 'refused';
  };
  const retry: Array<{ row: Row; w: ActivityWrite }> = [];

  for (let i = 0; i < todo.length && stopped === null; i += CARD_REWRITE_BATCH) {
    const batch = todo.slice(i, i + CARD_REWRITE_BATCH);
    // Re-read right before writing: the database read is minutes old.
    let fresh: Map<string, RewriteRestRow>;
    try {
      fresh = new Map((await deps.searchByIds(batch.map((r) => r.id))).map((r) => [r.id, r]));
    } catch (e) {
      stopped = `could not re-read a batch (${message(e)})`;
      break;
    }
    const send: Array<{ row: Row; w: ActivityWrite }> = [];
    for (const r of batch) {
      const f = fresh.get(r.id);
      if (!f) leave(r, 'it is gone from Wealthfolio');
      else if (f.accountId && f.accountId !== r.account_id) leave(r, 'it has moved to another account');
      else if (f.activityType.toUpperCase() !== 'WITHDRAWAL') leave(r, `it is now a ${f.activityType}`);
      else if ((f.sourceGroupId ?? '').trim()) leave(r, 'it is now in a transfer group');
      else if (!BOOKKEEPING_PREFIXES.some((p) => (f.comment ?? '').startsWith(p))) leave(r, 'its note is no longer the sync\'s');
      else send.push({ row: r, w: transferOut(r, f) });
    }
    if (send.length === 0) continue;
    const bulk = await write(send.map((x) => x.w));
    if (bulk.r === 'ok') { done.push(...send.map((x) => x.row.id)); continue; }
    if (bulk.r === 'temporary') { stopped = bulk.why; break; }
    // All or nothing: one refused row sends the batch back, so each goes alone.
    for (const x of send) {
      const out = await alone(x.row, x.w);
      if (out === 'stop') break;
      if (out === 'refused') retry.push(x);
    }
  }
  // A row refused alone gets one more try; refused twice, it is left for good.
  for (const x of retry) {
    if (stopped !== null) break;
    const out = await alone(x.row, x.w);
    if (out === 'refused') { refused.push(x.row.id); left.push(x.row); }
  }

  if ((done.length > 0 || refused.length > 0) && deps.record) {
    try {
      deps.record(bookkeepingChange({ step: 'card-transfer-out', activityIds: done, ...(refused.length ? { refused } : {}) }));
    } catch (err) {
      deps.log(`Could not record the change: ${String(err)}`);
    }
  }
  if (stopped !== null) {
    deps.log(`Card bookkeeping rewrite stopped after ${done.length} of ${todo.length} rows (${stopped}); the next sync carries on.`);
    return { kind: 'stopped', rewritten: done.length, why: stopped };
  }
  try {
    await deps.marker.set(deps.now.toISOString());
  } catch (e) {
    const why = `could not record that it finished (${message(e)})`;
    deps.log(`Card bookkeeping rewrite wrote ${done.length} row(s) but ${why}; the next sync marks it done.`);
    return { kind: 'stopped', rewritten: done.length, why };
  }
  if (done.length > 0) deps.log(`Restated ${done.length} card bookkeeping row(s) as transfers out, which Wealthfolio leaves out of spending.`);
  return { kind: 'done', rewritten: done.length, left: left.length };
}
