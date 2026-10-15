/**
 * shared/payback-app.ts
 *
 * Paybacks in the app (1.62.0, W11): what the add-on's "It's a payback…"
 * decides before it writes anything. Pure.
 *
 * The add-on SDK has no call that files one transaction, so the app files a
 * payback through a categorization rule of its own that only that row matches
 * — a one-off rule: the row's exact note, its account, CREDIT only, far above
 * every other rule — which Wealthfolio's rule run applies, and which is deleted
 * after (shared/payback-app-file.ts). Wealthfolio's matcher upper-cases both
 * sides of an exact match, skips a rule scoped to another account, and needs
 * the row's effective type to equal the rule's; the highest priority wins
 * (upstream categorization_rules/matcher.rs `match_compiled`). The rule's key
 * is rebuilt from what the rule itself keeps — its account and the tx id in its
 * pattern — because `getRules` lists no keys and `deleteRule` needs one: so a
 * rule a failed run left behind is swept by the next payback.
 *
 * The gate: a host that offers Wealthfolio's facts (3.9+, `hostCan`), since
 * the filing is confirmed by reading them back, and a companion of 1.62.0 or
 * newer (an older one turns a payback back into a deposit; with none at all,
 * nothing could undo it). The action is hidden otherwise.
 */
import { isCorrectionNote, isPendingNote, isPlaceholderNote, isStartingBalanceNote } from './audit-ledger.js';
import { SYNC_BOOKKEEPING_CATEGORY } from './bookkeeping-filing.js';
import { PAYBACK_UNAVAILABLE, PAYBACK_UPDATE_COMPANION, paybackOnceName } from './payback-copy.js';
import type { PaybackRow } from './payback-row.js';
import { descriptionFromComment, OPENING_BALANCES_CATEGORY, txIdFromComment } from './sync-core.js';
import type { TxStoryFacts } from './tx-story.js';
import { companionUnderstandsPaybacks } from './version.js';

/** The one-off rule's priority: far above any rule a person makes, and W10's
 *  (50) — Wealthfolio stores an i32 and checks no range. */
export const PAYBACK_ONCE_PRIORITY = 1_000_000;

/** The one-off rule's key, `payback-once:<accountId>:<txId>`. */
export const paybackOnceKey = (accountId: string, txId: string): string => `payback-once:${accountId}:${txId}`;

/** A one-off rule, as `spending.saveRule` takes it. */
export interface PaybackOnceRule {
  ruleKey: string;
  name: string;
  pattern: string;
  matchType: 'exact';
  kind: 'expense';
  categoryId: string;
  activityType: 'CREDIT';
  accountId: string;
  priority: number;
}

/** The rule that files exactly this row, once it is a CREDIT, under the
 *  category; null when its note carries no tx id. */
export function paybackOnceRule(row: Pick<PaybackRow, 'accountId' | 'notes'>, categoryId: string): PaybackOnceRule | null {
  const txId = txIdFromComment(row.notes);
  if (!txId) return null;
  return {
    ruleKey: paybackOnceKey(row.accountId, txId),
    name: paybackOnceName(descriptionFromComment(row.notes) || txId),
    pattern: row.notes,
    matchType: 'exact',
    kind: 'expense',
    categoryId,
    activityType: 'CREDIT',
    accountId: row.accountId,
    priority: PAYBACK_ONCE_PRIORITY,
  };
}

/** One of this add-on's rules as `spending.getRules` lists it: no key. */
export interface ListedRule {
  name?: string;
  pattern?: string;
  accountId?: string | null;
  activityType?: string | null;
  priority?: number;
}

/** The keys of one-off payback rules still in Wealthfolio: this add-on's
 *  rules at the one-off priority, CREDIT only, scoped to an account, whose
 *  pattern carries a tx id. */
export function leftoverPaybackKeys(rules: readonly ListedRule[]): string[] {
  const keys = new Set<string>();
  for (const r of rules) {
    if (r.priority !== PAYBACK_ONCE_PRIORITY || r.activityType !== 'CREDIT' || !r.accountId || typeof r.pattern !== 'string') continue;
    const txId = txIdFromComment(r.pattern);
    if (txId) keys.add(paybackOnceKey(r.accountId, txId));
  }
  return [...keys];
}

/** Why the app cannot file a payback now, or null. `hostOffersFacts`:
 *  `hostCan(ctx, 'spending.searchCashActivities')` (Wealthfolio 3.9+). */
export function appPaybackGate(f: { hostOffersFacts: boolean; companionVersion: string | null }): string | null {
  if (!f.hostOffersFacts || f.companionVersion === null) return PAYBACK_UNAVAILABLE;
  return companionUnderstandsPaybacks(f.companionVersion) ? null : PAYBACK_UPDATE_COMPANION;
}

/** A category as a payback reads it (`spending.getCategories`). */
export interface PaybackCategory {
  id: string;
  name: string;
  /** Its parent's name, whose spending a payback comes off ("Food & Dining"
   *  for Restaurants); null for a top-level category. */
  parentName: string | null;
  /** "Food & Dining / Restaurants": what the picker shows. */
  path: string;
  /** `expense` (spending), `income` or `saving`. */
  kind: string;
}

/** Upstream `buildCategoryPath` joins the names with this. */
const PATH_SEPARATOR = ' / ';
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** `spending.getCategories()` as a payback reads it; an entry it cannot read is left out. */
export function paybackCategoriesOf(raw: unknown): PaybackCategory[] {
  if (!Array.isArray(raw)) return [];
  const out: PaybackCategory[] = [];
  for (const c of raw) {
    if (!isRecord(c) || typeof c.categoryId !== 'string' || !c.categoryId || typeof c.name !== 'string') continue;
    const path = typeof c.path === 'string' && c.path.trim() !== '' ? c.path : c.name;
    const parts = path.split(PATH_SEPARATOR);
    out.push({
      id: c.categoryId,
      name: c.name,
      parentName: parts.length > 1 ? parts[parts.length - 2] : null,
      path,
      kind: typeof c.kind === 'string' ? c.kind : '',
    });
  }
  return out;
}

/** What the picker offers: the spending categories by path, without the
 *  add-on's own bookkeeping ones (a payback filed there comes off nothing). */
export function paybackPickList(categories: readonly PaybackCategory[]): PaybackCategory[] {
  return categories
    .filter((c) => c.kind === 'expense' && c.name !== OPENING_BALANCES_CATEGORY && c.name !== SYNC_BOOKKEEPING_CATEGORY)
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Whether a story offers "It's a payback…": a posted DEPOSIT on a cash
 * account, from the bank feed, not one the sync manages, not $0, in no
 * transfer as far as the story knows, filed nowhere on Wealthfolio's own word
 * (a 3.9 fact — the filing needs one anyway), and not a payback already.
 * Everything is checked again when it is filed.
 */
export function paybackOfferedInStory(facts: TxStoryFacts): boolean {
  const note = facts.row.note ?? '';
  const failed = new Set(facts.failed ?? []);
  if (!facts.feed || failed.has('mapping') || failed.has('partner') || failed.has('overrides') || failed.has('overridesUnreadable')) return false;
  if (facts.partner !== null) return false;
  if (facts.category !== null) return false;
  if (facts.row.activityType.toUpperCase() !== 'DEPOSIT' || (facts.row.accountType ?? '').toUpperCase() !== 'CASH') return false;
  if (!(facts.row.absCents > 0)) return false;
  if (!txIdFromComment(note) || isPendingNote(note) || isPlaceholderNote(note) || isStartingBalanceNote(note) || isCorrectionNote(note)) return false;
  return !(facts.overrides ?? []).includes('asReimbursement');
}
