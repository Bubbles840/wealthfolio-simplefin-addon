/**
 * shared/audit-ledger.ts
 *
 * The ledger as the audits read it (2c): one row per Wealthfolio activity,
 * read by the companion straight from the database (companion/src/
 * sqlite-audit.ts) and judged here and in audit-balance.ts and
 * audit-health.ts. Pure.
 *
 * Two activity types on purpose. `rawType` is what moves cash — every
 * balance figure in this project signs by it (getNativeAccountBalances,
 * ledger-facts' CASH_EFFECT, the audit scripts). `type` is
 * `activity_type_override ?? activity_type`, which is what Wealthfolio's
 * Health page reads (companion/tools/audit-health.mjs part 1).
 */
import {
  BALANCE_ADJUSTMENT_COMMENT_PREFIX, IN_TRANSIT_COMMENT_PREFIX, PENDING_SUFFIX, STARTING_BALANCE_COMMENT_PREFIX,
} from './sync-core.js';

/** One Wealthfolio account. */
export interface AuditAccount {
  id: string;
  name: string;
  /** Upper-case: 'CASH', 'CREDIT_CARD', … ('' when unset). */
  type: string;
  archived: boolean;
  /** `is_active`; absent reads as active. Wealthfolio's Health looks only at
   *  active accounts that are not archived. */
  active?: boolean;
}

/** One activity. */
export interface AuditLedgerRow {
  id: string;
  accountId: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Upper-case. */
  currency: string;
  /** `activity_type`, upper-case: what moves cash. */
  rawType: string;
  /** `activity_type_override ?? activity_type`, upper-case: what Health reads. */
  type: string;
  /** Upper-case; 'POSTED' when unset. */
  status: string;
  absCents: number;
  /** `source_group_id`, '' when none. */
  group: string;
  /** `asset_id`, '' when none. */
  assetId: string;
  /** `quantity`, when the row has one (security legs); absent when unread. */
  quantity?: number | null;
  /** `metadata.flow.is_external` is JSON true. */
  external: boolean;
  /** `asset_id` names the phantom `$CASH` security. */
  phantomCash: boolean;
  /** The stored note, raw. */
  notes: string;
}

export interface AuditLedger {
  accounts: AuditAccount[];
  rows: AuditLedgerRow[];
}

const PLUS = new Set(['DEPOSIT', 'CREDIT', 'TRANSFER_IN', 'DIVIDEND', 'INTEREST', 'SELL']);
const MINUS = new Set(['WITHDRAWAL', 'TRANSFER_OUT', 'FEE', 'TAX', 'BUY']);

/**
 * THE one sign table (1.64, R14): Wealthfolio 3.8's `type_directed_cash_effect`
 * with its one account-dependent exception (card interest is a charge). Three
 * readers share it so a card can never be "in sync" on one side and "off by $X"
 * on the other: the app's own total (shared/ledger-total.ts), the audits
 * through `cashEffectCents`, and the companion's SQL through `cashSignSql`.
 * Case-blind; types that move no cash (SPLIT, ADJUSTMENT, unknown) are 0.
 */
export function typeCashSign(type: string, accountType: string): -1 | 0 | 1 {
  const t = String(type ?? '').toUpperCase();
  if (String(accountType ?? '').toUpperCase() === 'CREDIT_CARD' && t === 'INTEREST') return -1;
  if (PLUS.has(t)) return 1;
  if (MINUS.has(t)) return -1;
  return 0;
}

/**
 * The same table as a SQL `CASE`, over expressions that are ALREADY upper-cased
 * (the caller owns the COALESCE/UPPER, so the effective-type choice stays in
 * one place). The sign-agreement test pins it against `typeCashSign`.
 */
export function cashSignSql(typeExpr: string, accountTypeExpr: string): string {
  const list = (set: Set<string>) => [...set].map((t) => `'${t}'`).join(',');
  return `CASE WHEN ${accountTypeExpr} = 'CREDIT_CARD' AND ${typeExpr} = 'INTEREST' THEN -1`
    + ` WHEN ${typeExpr} IN (${list(PLUS)}) THEN 1`
    + ` WHEN ${typeExpr} IN (${list(MINUS)}) THEN -1 ELSE 0 END`;
}

/**
 * The row's signed effect on its account's cash, in cents, from its RAW type
 * (the audits' figure, unchanged): `typeCashSign` times the amount.
 */
export function cashEffectCents(row: Pick<AuditLedgerRow, 'rawType' | 'absCents'>, accountType: string): number {
  const sign = typeCashSign(row.rawType, accountType);
  return sign === 0 ? 0 : sign * row.absCents;
}

export const isPendingNote = (notes: string): boolean => notes.endsWith(PENDING_SUFFIX);
export const isPlaceholderNote = (notes: string): boolean => notes.startsWith(IN_TRANSIT_COMMENT_PREFIX);
export const isStartingBalanceNote = (notes: string): boolean => notes.startsWith(STARTING_BALANCE_COMMENT_PREFIX);
export const isCorrectionNote = (notes: string): boolean => notes.startsWith(BALANCE_ADJUSTMENT_COMMENT_PREFIX);
