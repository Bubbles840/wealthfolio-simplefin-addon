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
import { hostTakesCardTransferOut } from '../../shared/version.js';
import { PHANTOM_CASH_ASSET_ID } from './sqlite-audit.js';

/** The secret that says the rewrite finished (an ISO timestamp). */
export const CARD_REWRITE_SECRET_KEY = 'card_bookkeeping_rewrite';
/** Rows per bulk request. */
export const CARD_REWRITE_BATCH = 50;

export interface CardRewriteDeps {
  dbPath: string;
  /** Wealthfolio's version (`GET /app/info`); null when unknown. */
  wealthfolioVersion: string | null;
  marker: { get(): Promise<string | null>; set(value: string): Promise<void> };
  saveMany(req: SaveManyRequest): Promise<SaveManyResult>;
  /** The change log: one draft per run that wrote anything. */
  record?(draft: ChangeDraft): void;
  log(message: string): void;
  now: Date;
}

export type CardRewriteOutcome =
  | { kind: 'done-before' }
  | { kind: 'older-host' }
  | { kind: 'no-database' }
  | { kind: 'done'; rewritten: number; left: number }
  | { kind: 'stopped'; rewritten: number; why: string };

interface Row {
  id: string; account_id: string; activity_date: string; amount: string; currency: string; notes: string;
  grp: string; asset_id: string; override: string;
  /** The stored asset's display code / instrument symbol / name; '' when the asset row is missing. */
  asset_codes: string;
  asset_label: string;
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

function open(dbPath: string): DatabaseSync | null {
  if (!dbPath || !existsSync(dbPath)) return null;
  for (const uri of [`file:${dbPath}?mode=ro`, `file:${dbPath}?mode=ro&readonly_shm=1`, `file:${dbPath}?immutable=1`]) {
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

function cardWithdrawals(dbPath: string): Row[] | null {
  const db = open(dbPath);
  if (!db) return null;
  try {
    return db.prepare(
      `SELECT a.id, a.account_id, COALESCE(a.activity_date,'') activity_date, COALESCE(a.amount,'0') amount,
              COALESCE(a.currency,'') currency, COALESCE(a.notes,'') notes, TRIM(COALESCE(a.source_group_id,'')) grp,
              TRIM(COALESCE(a.asset_id,'')) asset_id, TRIM(COALESCE(a.activity_type_override,'')) override,
              COALESCE(s.display_code,'') || char(31) || COALESCE(s.instrument_symbol,'') || char(31) || COALESCE(s.name,'') asset_codes,
              COALESCE(NULLIF(s.display_code,''), NULLIF(s.instrument_symbol,''), s.name, '') asset_label
       FROM activities a JOIN accounts acc ON a.account_id = acc.id
       LEFT JOIN assets s ON s.id = a.asset_id
       WHERE UPPER(acc.account_type) = 'CREDIT_CARD'
         AND UPPER(a.activity_type) = 'WITHDRAWAL'
         AND (COALESCE(a.notes,'') LIKE ? || '%' OR COALESCE(a.notes,'') LIKE ? || '%' OR COALESCE(a.notes,'') LIKE ? || '%')
       ORDER BY a.activity_date, a.id`,
    ).all(STARTING_BALANCE_COMMENT_PREFIX, BALANCE_ADJUSTMENT_COMMENT_PREFIX, IN_TRANSIT_COMMENT_PREFIX) as unknown as Row[];
  } finally {
    db.close();
  }
}

const transferOut = (r: Row): ActivityWrite => ({
  id: r.id,
  accountId: r.account_id,
  activityType: 'TRANSFER_OUT',
  // The stored instant, verbatim: a date-only value would move the row.
  activityDate: r.activity_date,
  amount: Math.abs(Number(r.amount) || 0),
  fee: 0,
  currency: r.currency,
  comment: r.notes,
  metadata: EXTERNAL_BOOKKEEPING_METADATA,
  // A phantom "$CASH" asset is cleared by naming the cash symbol (3.10+).
  ...(assetKind(r) === 'phantom' ? { symbol: { symbol: `$CASH-${(r.currency || 'USD').toUpperCase()}` } } : {}),
});

export async function rewriteCardBookkeeping(deps: CardRewriteDeps): Promise<CardRewriteOutcome> {
  if (await deps.marker.get()) return { kind: 'done-before' };
  if (!hostTakesCardTransferOut(deps.wealthfolioVersion)) return { kind: 'older-host' };
  const rows = cardWithdrawals(deps.dbPath);
  if (rows === null) return { kind: 'no-database' };

  const left = rows.filter((r) => r.grp || r.override || assetKind(r) === 'security');
  const todo = rows.filter((r) => !left.includes(r));
  for (const r of left) {
    const why = r.grp ? 'it is in a transfer group' : r.override ? `you typed it ${r.override} in Wealthfolio` : `it carries a security (${r.asset_label || r.asset_id})`;
    deps.log(`Card bookkeeping rewrite: left ${r.id} as a WITHDRAWAL — ${why}.`);
  }

  const done: string[] = [];
  let stopped: string | null = null;
  for (let i = 0; i < todo.length && stopped === null; i += CARD_REWRITE_BATCH) {
    const batch = todo.slice(i, i + CARD_REWRITE_BATCH);
    try {
      const res = await deps.saveMany({ updates: batch.map(transferOut) });
      if (res.errors.length > 0) stopped = res.errors.map((e) => `${e.action}: ${e.message}`).join('; ');
      else done.push(...batch.map((r) => r.id));
    } catch (e: any) {
      stopped = String(e?.message ?? e);
    }
  }

  if (done.length > 0 && deps.record) {
    try {
      deps.record(bookkeepingChange({ step: 'card-transfer-out', activityIds: done }));
    } catch (err) {
      deps.log(`Could not record the change: ${String(err)}`);
    }
  }
  if (stopped !== null) {
    deps.log(`Card bookkeeping rewrite stopped after ${done.length} of ${todo.length} rows (${stopped}); the next sync carries on.`);
    return { kind: 'stopped', rewritten: done.length, why: stopped };
  }
  await deps.marker.set(deps.now.toISOString());
  if (done.length > 0) deps.log(`Restated ${done.length} card bookkeeping row(s) as transfers out, which Wealthfolio leaves out of spending.`);
  return { kind: 'done', rewritten: done.length, left: left.length };
}
