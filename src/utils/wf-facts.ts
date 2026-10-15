/**
 * src/utils/wf-facts.ts
 *
 * The add-on's reads of what Wealthfolio says about its rows (1.62.0, U3),
 * through the SDK 3.9 calls, each behind `hostCan`. A host that does not
 * offer a call (3.8), or a read that fails, gives no facts — and every
 * caller then keeps the rule it used before 3.9. Each call is made as a
 * method on `ctx.api`.
 */
import type { AddonContext, CashActivitySearchRequest } from '@wealthfolio/addon-sdk';
import { CASH_FACTS_PAGE, cashFactOf, cashFactQuery, factDay, type CashFact } from '../../shared/wf-facts';
import { hostCan } from './host-can';

/** Pages read per account and day, at most. One account's day never fills one. */
const MAX_PAGES = 3;

/** The rows' facts, by activity id — a row Wealthfolio does not return has
 *  none. Null: no facts at all (the host does not offer the call, or a read
 *  failed). */
export async function readCashFacts(
  ctx: AddonContext,
  rows: ReadonlyArray<{ id: string; accountId: string; date: string }>,
): Promise<Map<string, CashFact> | null> {
  if (rows.length === 0 || !(await hostCan(ctx, 'spending.searchCashActivities'))) return null;
  const wanted = new Set(rows.map((r) => r.id));
  const days = new Map<string, { accountId: string; date: string }>();
  for (const r of rows) days.set(`${r.accountId}\u0000${factDay(r.date)}`, r);
  const facts = new Map<string, CashFact>();
  try {
    for (const row of days.values()) {
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await ctx.api.spending.searchCashActivities(cashFactQuery(row, page * CASH_FACTS_PAGE) as CashActivitySearchRequest);
        const items = res?.items ?? [];
        for (const item of items) {
          const fact = cashFactOf(item);
          if (fact && wanted.has(fact.activityId)) facts.set(fact.activityId, fact);
        }
        if (items.length < CASH_FACTS_PAGE || (page + 1) * CASH_FACTS_PAGE >= (res?.totalCount ?? 0)) break;
      }
    }
  } catch {
    return null;
  }
  return facts;
}

/** The other half of a linked transfer. */
export interface FactPartner {
  activityId: string;
  accountId: string;
  /** YYYY-MM-DD: the UTC day of its stored instant. */
  date: string;
}

/** Wealthfolio's own pair for a row (`activities.getTransferPair`): the other
 *  half; null when the row is in no valid pair; undefined when the host does
 *  not offer the call or the read fails. */
export async function readTransferPartner(ctx: AddonContext, activityId: string): Promise<FactPartner | null | undefined> {
  if (!(await hostCan(ctx, 'activities.getTransferPair'))) return undefined;
  try {
    const pair = await ctx.api.activities.getTransferPair(activityId);
    if (!pair) return null;
    const other = pair.transferOut?.id === activityId ? pair.transferIn : pair.transferIn?.id === activityId ? pair.transferOut : null;
    if (!other || typeof other.id !== 'string' || typeof other.accountId !== 'string') return undefined;
    return { activityId: other.id, accountId: other.accountId, date: factDay(String(other.activityDate ?? '')) };
  } catch {
    return undefined;
  }
}

/** Every category's name, by id (`spending.getCategories`, all kinds —
 *  offered since Wealthfolio 3.8, so it needs no feature check); null when the
 *  host object has no such call or the read fails. */
export async function readCategoryNames(ctx: AddonContext): Promise<Map<string, string> | null> {
  if (typeof (ctx.api as { spending?: { getCategories?: unknown } } | undefined)?.spending?.getCategories !== 'function') return null;
  try {
    const categories = await ctx.api.spending.getCategories();
    return new Map((categories ?? []).map((c) => [c.categoryId, c.name]));
  } catch {
    return null;
  }
}
