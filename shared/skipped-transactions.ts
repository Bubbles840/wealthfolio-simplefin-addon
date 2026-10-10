/**
 * shared/skipped-transactions.ts
 *
 * Bank transactions the sync must never import.
 *
 * For a feed that reports one real transaction twice under two ids (live,
 * 2026-10-09: PNC sent the same $600 deposit in its old and its new wording, and
 * the account read $600 high). Deleting the extra row does not stick — the next
 * sync sees an id with no stored row and imports it again, for as long as the
 * bank keeps reporting it. Listing it here is what makes the deletion permanent.
 *
 * Per ACCOUNT, because SimpleFin gives both sides of an internal transfer one id:
 * skipping it in one account must not drop the other side.
 *
 * The sync only stops importing. It never deletes a stored copy on this list's
 * behalf — removing money from a ledger stays a step a person takes.
 *
 * Both writers (companion and addon) read the same secret.
 */

export const SKIPPED_TRANSACTIONS_SECRET_KEY = 'skipped_transactions';

export interface SkippedTransaction {
  /** SimpleFin account id. */
  account: string;
  /** SimpleFin transaction id. */
  txId: string;
  /** Why, in the user's words — shown wherever the list is. */
  note?: string;
  /** When it was added (ISO). */
  at?: string;
}

/** The stored list; anything malformed reads as absent (= import as usual). */
export function parseSkippedTransactions(raw: string | null | undefined): SkippedTransaction[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((e): e is SkippedTransaction =>
    !!e && typeof e === 'object'
    && typeof (e as SkippedTransaction).account === 'string'
    && typeof (e as SkippedTransaction).txId === 'string');
}
