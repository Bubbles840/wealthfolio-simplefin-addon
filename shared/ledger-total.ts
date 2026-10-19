import { typeCashSign } from './audit-ledger.js';
import { IN_TRANSIT_COMMENT_PREFIX } from './reconcile.js';
import { PENDING_SUFFIX } from './sync-core.js';

/**
 * A card's POSTED total, added up by the app itself (1.64, B1).
 *
 * Why the app must do it: Wealthfolio's valuations are cash-only, so a credit
 * card has no figure to compare SimpleFin against, and after an in-app Sync
 * every card said "not checked". `activities.search` does return each row's
 * effective type, so the app can sum the card's history exactly as the
 * companion's SQL (getNativeAccountBalances) does. Three rules are shared with
 * that reader, and the sign-agreement test pins them together (R14):
 *   1. signed by the one table, `typeCashSign` (card interest is a charge);
 *   2. pending rows (note ends with PENDING_SUFFIX) are left out - SimpleFin
 *      reports the POSTED balance, so counting them reports timing as drift;
 *   3. an account holding an in-transit placeholder has NO figure (null): the
 *      two ends of a transfer are measuring different moments.
 */
export interface LedgerTotalRow {
  activityType: string;
  amount: unknown;
  comment?: string | null;
}

export function postedLedgerTotal(rows: ReadonlyArray<LedgerTotalRow>, accountType: string): number | null {
  let cents = 0;
  for (const r of rows) {
    const note = r.comment ?? '';
    if (note.startsWith(IN_TRANSIT_COMMENT_PREFIX)) return null;
    if (note.endsWith(PENDING_SUFFIX)) continue;
    const abs = Math.abs(Number(r.amount));
    if (r.amount === null || r.amount === undefined || r.amount === '' || !Number.isFinite(abs)) continue;
    cents += typeCashSign(r.activityType, accountType) * Math.round(abs * 100);
  }
  return cents / 100;
}
