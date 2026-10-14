/**
 * shared/payback.ts
 *
 * Paybacks (1.62.0, W6–W10): a deposit that pays you back for spending — a
 * friend's Venmo for dinner — filed against that spending. Since 3.9,
 * Wealthfolio decides which categories a row can take from the row's type: a
 * cash DEPOSIT is income, and only a CREDIT marked REIMBURSEMENT (REFUND,
 * REBATE) comes off spending (`classify_activity`,
 * crates/spending/src/activity_classification.rs:98-130 at 3.8.0/3.9.0,
 * :100-132 at 3.10.0). So filing a payback re-types the row before it files
 * it:
 *
 *  1. the `asReimbursement` override, under every feed of the row's account,
 *     through `editSyncOverrides` (which re-reads right before it writes), so
 *     the sync keeps the row a payback instead of reverting it (W7);
 *  2. the row: a CREDIT marked REIMBURSEMENT, everything else as stored — its
 *     date written back as the very instant Wealthfolio holds, so a retype
 *     never moves a row to another day;
 *  3. the spending category;
 *  4. a `payback-filed` change-log entry, whose Undo reverses all three.
 *
 * `planPayback` decides from facts re-read right before writing; a refusal
 * writes nothing and says why in its own words. Pure.
 */
import { isCorrectionNote, isPendingNote, isPlaceholderNote, isStartingBalanceNote } from './audit-ledger.js';
import { REIMBURSEMENT_SUBTYPE } from './cash-flow-bucket.js';
import type { PaybackFiledFacts } from './change-entries.js';
import { fixRowOf } from './fix-row.js';
import {
  PAYBACK_ALREADY, PAYBACK_GONE, PAYBACK_LINKED, PAYBACK_MANAGED, PAYBACK_NOT_CASH, PAYBACK_NOT_DEPOSIT, PAYBACK_NOT_FEED,
  PAYBACK_PENDING, PAYBACK_TRANSFER,
} from './payback-copy.js';
import { isPaybackRow, paybackRetype, type PaybackRow } from './payback-row.js';
import { descriptionFromComment, isTransferType, txIdFromComment } from './sync-core.js';
import type { ActivityWrite } from './sync-host.js';
import { hasTxOverride, SYNC_OVERRIDES_UNREADABLE_MESSAGE, type LoadedSyncOverrides } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';

/** An ActivityDetails row as a payback reads it; null when the fixes' reader
 *  refuses it (no id, account, type, date or currency). */
export function paybackRowOf(raw: unknown, accountType: string): PaybackRow | null {
  const row = fixRowOf(raw, accountType);
  if (!row) return null;
  const at = (raw as { date?: unknown }).date;
  return { ...row, instant: typeof at === 'string' && at.trim() !== '' ? at.trim() : row.date };
}

/** What `planPayback` decides from, all re-read right before the write. */
export interface PaybackFacts {
  /** The row by exact id; null when gone. */
  row: PaybackRow | null;
  /** The SimpleFin accounts that sync into the row's account ([] when none). */
  feeds: string[];
  /** `loadSyncOverrides`, as just read. */
  overrides: LoadedSyncOverrides;
  /** The spending category picked. */
  category: { id: string; name: string };
}

/** What a payback writes, in order. */
export interface PaybackWrites {
  /** The row's key under every feed of its account: `asReimbursement` goes on each. */
  txKeys: string[];
  /** The overrides list's words for it: "<bank text> · <account>". */
  label: string;
  /** The row as a CREDIT marked REIMBURSEMENT. */
  update: ActivityWrite;
  /** The spending category. */
  assign: { activityId: string; categoryId: string };
  /** The change-log entry's facts (`paybackFiledChange`). */
  entry: PaybackFiledFacts;
}

export type PaybackPlan = { ok: true; writes: PaybackWrites } | { ok: false; reason: string };

const no = (reason: string): PaybackPlan => ({ ok: false, reason });

/**
 * Decide a payback. Refused, each in its own words and with nothing written:
 * a row that is gone; one the sync manages (a held transfer, a starting
 * balance, a correction); one not from the bank feed (no tx id, or an account
 * no feed maps to — the override needs a key the sync reads); half of a
 * linked transfer; a transfer; a pending row (SimpleFin often gives it a new
 * id when it posts, which the override would not follow); a row outside a
 * cash account (on a card every CREDIT already comes off spending); one that
 * is already a payback (by its type or its override); anything but a
 * DEPOSIT; and an overrides document that cannot be read (never overwritten).
 */
export function planPayback(f: PaybackFacts): PaybackPlan {
  const row = f.row;
  if (!row) return no(PAYBACK_GONE);
  if (isPlaceholderNote(row.notes) || isStartingBalanceNote(row.notes) || isCorrectionNote(row.notes)) return no(PAYBACK_MANAGED);
  const txId = txIdFromComment(row.notes);
  if (!txId || f.feeds.length === 0) return no(PAYBACK_NOT_FEED);
  if (row.grouped) return no(PAYBACK_LINKED);
  if (isTransferType(row.type)) return no(PAYBACK_TRANSFER);
  if (isPendingNote(row.notes)) return no(PAYBACK_PENDING);
  if (row.accountType !== 'CASH') return no(PAYBACK_NOT_CASH);
  const txKeys = f.feeds.map((sfin) => accountTxKey(sfin, txId));
  if (isPaybackRow(row) || txKeys.some((k) => hasTxOverride(f.overrides.overrides, k, 'asReimbursement'))) return no(PAYBACK_ALREADY);
  if (row.type !== 'DEPOSIT') return no(PAYBACK_NOT_DEPOSIT);
  if (f.overrides.unreadable) return no(SYNC_OVERRIDES_UNREADABLE_MESSAGE);
  const description = descriptionFromComment(row.notes);
  const what = description || 'a transaction';
  return {
    ok: true,
    writes: {
      txKeys,
      label: row.accountName ? `${what} · ${row.accountName}` : what,
      update: paybackRetype(row, 'CREDIT', REIMBURSEMENT_SUBTYPE),
      assign: { activityId: row.id, categoryId: f.category.id },
      entry: {
        account: { sfinId: f.feeds[0], wfId: row.accountId, name: row.accountName },
        txKeys,
        activityId: row.id,
        description,
        amountCents: row.absCents,
        date: row.date,
        subtypeBefore: row.subtype,
        categoryId: f.category.id,
        categoryName: f.category.name,
      },
    },
  };
}
