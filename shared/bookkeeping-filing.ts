/**
 * shared/bookkeeping-filing.ts
 *
 * Which of the sync's own bookkeeping rows go under "Sync bookkeeping", the
 * spending category Wealthfolio is told to leave out of spending (1.62,
 * ruling W3), and which come back out. Pure: the companion reads the rows and
 * writes the filings (companion/src/bookkeeping-category.ts).
 *
 * The sync writes three kinds of row for its own bookkeeping, each known by
 * the note it carries (shared/audit-ledger.ts):
 *  - a transfer in transit (`isPlaceholderNote`): its other half has not
 *    arrived. Money out is a TRANSFER_OUT on cash and a WITHDRAWAL on a card;
 *    money in a TRANSFER_IN on either;
 *  - a balance correction (`isCorrectionNote`): out is TRANSFER_OUT on cash
 *    and WITHDRAWAL on a card; in is CREDIT on cash and TRANSFER_IN on a card
 *    (`neutralAdjustmentFields`);
 *  - a starting balance (`isStartingBalanceNote`): cash in is CREDIT, cash out
 *    WITHDRAWAL; a card's opening debt WITHDRAWAL, a card in credit
 *    TRANSFER_IN (`startingBalanceFields`).
 * Wealthfolio's classifier puts the money-out shapes in its SPENDING bucket
 * (cash TRANSFER_OUT and WITHDRAWAL, card WITHDRAWAL: Expense); TRANSFER_IN on
 * cash is Income, and CREDIT without a refund subtype and TRANSFER_IN on a
 * card are Ignored. Only a spending-bucket row can take a spending category,
 * and only those count as spending, so only those are filed — read through
 * the one definition (shared/wf-spending.ts), so a row Wealthfolio no longer
 * counts (a card's bookkeeping written as TRANSFER_OUT on 3.10, a linked
 * transfer) is never filed.
 *
 * Filed: a spending-bucket bookkeeping row with NO spending filing. A row the
 * person (or a rule, or the opening-balance filing) already filed is theirs.
 * Taken out: a row THIS PASS filed under "Sync bookkeeping" that is no longer bookkeeping — a
 * placeholder that expired into an ordinary deposit or withdrawal loses its
 * marker, and must be uncategorized like any real row.
 *
 * A placeholder that LINKS is deleted and re-created as a linked pair
 * (`linkPairByRecreate`), and Wealthfolio deletes a row's filings with it
 * (`activity_taxonomy_assignments`, FOREIGN KEY … ON DELETE CASCADE, 3.8+):
 * the new rows start unfiled, and a linked transfer is never spending.
 */
import { isCorrectionNote, isPlaceholderNote, isStartingBalanceNote } from './audit-ledger.js';
import { STARTING_BALANCE_COMMENT_PREFIX } from './sync-core.js';
import { isSpendingBucket } from './wf-spending.js';

export const SYNC_BOOKKEEPING_CATEGORY = 'Sync bookkeeping';
export const SYNC_BOOKKEEPING_DESCRIPTION =
  "Rows the sync writes for its own bookkeeping: transfers waiting for their other half, balance corrections, starting balances. Not spending.";

/** True for a note the sync writes on its own bookkeeping rows. */
export function isSyncBookkeepingNote(notes: string): boolean {
  return isPlaceholderNote(notes) || isCorrectionNote(notes) || isStartingBalanceNote(notes);
}

/** One row as the pass reads it. */
export interface BookkeepingRow {
  id: string;
  /** Upper-case. */
  accountType: string;
  /** Upper-case. */
  type: string;
  typeOverride?: string;
  /** Upper-case; '' when none. */
  subtype: string;
  /** '' when none. */
  groupId: string;
  notes: string;
  /** Its spending-taxonomy filings' categories. */
  spendingCategoryIds: string[];
  /** True when the person split it across categories (`spending_activity_splits`):
   *  that counts as filed, and assigning a category would clear the split. */
  hasSplits?: boolean;
}

/** What the pass remembers between syncs: the category it filed under and the
 *  rows it filed there. Only these are ever taken back out. */
export interface FiledState { categoryId: string | null; ids: string[] }

/** The remembered state from its secret: absent is empty; anything that is not
 *  the expected shape is 'corrupt' — the pass then does nothing and never
 *  overwrites it. */
export function parseFiledState(raw: string | null): FiledState | 'corrupt' {
  if (raw === null) return { categoryId: null, ids: [] };
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'corrupt';
    const { categoryId, ids } = v as { categoryId?: unknown; ids?: unknown };
    if (!(categoryId === null || typeof categoryId === 'string')) return 'corrupt';
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) return 'corrupt';
    return { categoryId, ids: ids as string[] };
  } catch {
    return 'corrupt';
  }
}

export interface BookkeepingPlan {
  /** Rows to file under "Sync bookkeeping". */
  file: string[];
  /** Rows to take back out of it. */
  unfile: string[];
}

export function planBookkeepingFiling(
  rows: readonly BookkeepingRow[],
  opts: {
    /** "Sync bookkeeping"'s id, when it exists. */
    categoryId: string | null;
    /** The rows this pass filed under it (the remembered ids): the only ones
     *  it takes back out. A filing by hand or by a rule is the person's. */
    filedByPass: ReadonlySet<string>;
    /** True for a SimpleFin account whose opening-balance filing the person
     *  undid (`noOpeningFile`): its starting balance stays unfiled. */
    noOpeningFile?: (sfinAccountId: string) => boolean;
  },
): BookkeepingPlan {
  const plan: BookkeepingPlan = { file: [], unfile: [] };
  for (const row of rows) {
    const bookkeeping = isSyncBookkeepingNote(row.notes);
    if (!bookkeeping) {
      if (opts.categoryId && opts.filedByPass.has(row.id) && row.spendingCategoryIds.includes(opts.categoryId)) plan.unfile.push(row.id);
      continue;
    }
    if (row.spendingCategoryIds.length > 0 || row.hasSplits || !isSpendingBucket(row)) continue;
    if (isStartingBalanceNote(row.notes) && opts.noOpeningFile?.(row.notes.slice(STARTING_BALANCE_COMMENT_PREFIX.length))) continue;
    plan.file.push(row.id);
  }
  return plan;
}
