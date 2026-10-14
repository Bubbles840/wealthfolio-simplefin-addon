/**
 * shared/wf-facts.ts
 *
 * What Wealthfolio itself says about a cash row (1.62.0, U3), read through
 * the add-on SDK's `spending.searchCashActivities` on a 3.9+ host: whether a
 * transfer leg is linked, whether the row carries a group, its cash-flow
 * bucket and what it is filed under. These are facts, so where one is read
 * the app stops guessing "maybe linked" (change-undo-run.ts
 * `maybeLinkedTransfer`, fix-row.ts `linkedState`). Pure.
 *
 * Upstream (crates/spending cash_activities/service.rs, v3.9.0):
 *  - `transferLinkStatus` is set for an effective TRANSFER_IN/OUT only:
 *    `linked` — half of a valid pair; `invalid` — it carries a group that is
 *    not a valid pair; `unlinked` — no group. Any other type has none.
 *  - The call returns rows of accounts opted in to Spending, of the cash
 *    types, that Wealthfolio shows: an unlinked transfer out of a card
 *    (Ignored, 3.10) is not among them. A row it does not return has NO fact,
 *    and the caller keeps its old rule for it.
 *  - It has no id filter: rows are found by account and an inclusive RFC 3339
 *    window, at most 1,000 a page (`offset`, `limit`, `totalCount`).
 * A row in any group — linked, broken, or a non-transfer someone grouped —
 * counts as linked: deleting it deletes the rest of its group.
 */
import { SPENDING_TAXONOMY_ID } from './cash-flow-bucket.js';

export type TransferLinkStatus = 'linked' | 'unlinked' | 'invalid';
export type FactBucket = 'spending' | 'income' | 'saving' | 'neutral';

export interface FactFiling {
  taxonomyId: string;
  categoryId: string;
  /** `manual`, `rule`, … — who Wealthfolio says filed it. */
  source: string;
}

export interface CashFact {
  activityId: string;
  accountId: string;
  /** Wealthfolio's link status for a transfer leg; null for any other type. */
  link: TransferLinkStatus | null;
  /** The row carries a transfer group id. */
  grouped: boolean;
  bucket: FactBucket | null;
  filings: FactFiling[];
}

/** The most rows one `searchCashActivities` page returns (upstream `MAX_CASH_ACTIVITY_SEARCH_LIMIT`). */
export const CASH_FACTS_PAGE = 1000;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const LINK = new Set<string>(['linked', 'unlinked', 'invalid']);
const BUCKET = new Set<string>(['spending', 'income', 'saving', 'neutral']);

/** One `CashActivity` as the app reads it; null when it is not one this build can read. */
export function cashFactOf(raw: unknown): CashFact | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id || typeof raw.accountId !== 'string') return null;
  const status = raw.transferLinkStatus;
  if (status !== null && status !== undefined && (typeof status !== 'string' || !LINK.has(status))) return null;
  const bucket = typeof raw.cashFlowBucket === 'string' && BUCKET.has(raw.cashFlowBucket) ? raw.cashFlowBucket as FactBucket : null;
  const filings = (Array.isArray(raw.assignments) ? raw.assignments : [])
    .filter(isRecord)
    .filter((a) => typeof a.taxonomyId === 'string' && typeof a.categoryId === 'string')
    .map((a) => ({ taxonomyId: a.taxonomyId as string, categoryId: a.categoryId as string, source: typeof a.source === 'string' ? a.source : '' }));
  return {
    activityId: raw.id,
    accountId: raw.accountId,
    link: (status ?? null) as TransferLinkStatus | null,
    grouped: typeof raw.sourceGroupId === 'string' && raw.sourceGroupId.trim() !== '',
    bucket,
    filings,
  };
}

/** Linked, on Wealthfolio's word: any group at all, or a link status that is not `unlinked`. */
export function linkedOfFact(fact: CashFact): 'confirmed' | false {
  return fact.grouped || fact.link === 'linked' || fact.link === 'invalid' ? 'confirmed' : false;
}

/** What it is filed under: the spending filing when it has one, else any (as the companion's story picks). */
export function filingOfFact(fact: CashFact): FactFiling | null {
  return fact.filings.find((f) => f.taxonomyId === SPENDING_TAXONOMY_ID) ?? fact.filings[0] ?? null;
}

/** The UTC day of a stored instant (YYYY-MM-DD), or the first ten characters of what cannot be parsed. */
export function factDay(stored: string): string {
  const d = new Date(stored);
  return Number.isNaN(d.getTime()) ? stored.slice(0, 10) : d.toISOString().slice(0, 10);
}

/** The search that finds a row: its account, over the UTC day of its stored instant, both ends inclusive. */
export function cashFactQuery(row: { accountId: string; date: string }, offset = 0): {
  accountIds: string[]; startDate: string; endDate: string; offset: number; limit: number;
} {
  const day = factDay(row.date);
  return { accountIds: [row.accountId], startDate: `${day}T00:00:00.000Z`, endDate: `${day}T23:59:59.999Z`, offset, limit: CASH_FACTS_PAGE };
}
