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

/** The note a skip-list entry written by "Remove for good" (and its Redo) carries. */
export const REMOVED_FOR_GOOD_NOTE = 'Removed for good';

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

// ── Writing (R2: Undo of an import) ──────────────────────────────────────

export type ParsedSkippedTransactions =
  | { kind: 'ok'; list: SkippedTransaction[] }
  | { kind: 'absent' }
  | { kind: 'corrupt' };

const isSkipEntry = (e: unknown): e is SkippedTransaction => {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  const s = e as Record<string, unknown>;
  return typeof s.account === 'string' && typeof s.txId === 'string'
    && (s.note === undefined || typeof s.note === 'string')
    && (s.at === undefined || typeof s.at === 'string');
};

/** The stored list as a writer must see it: corrupt is NOT absent. Reading
 *  stays lenient (`parseSkippedTransactions`); a write over a list this cannot
 *  read in full would drop the entries it skipped. */
export function parseSkippedTransactionsStrict(raw: string | null | undefined): ParsedSkippedTransactions {
  if (raw === null || raw === undefined || raw.trim() === '') return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  return Array.isArray(parsed) && parsed.every(isSkipEntry) ? { kind: 'ok', list: parsed } : { kind: 'corrupt' };
}

export class SkippedTransactionsUnreadableError extends Error {
  constructor() {
    super("The list of transactions not to import can't be read, so nothing was changed.");
    this.name = 'SkippedTransactionsUnreadableError';
  }
}

/** The only write: re-read, edit, write. A stored list that cannot be read is
 *  never overwritten. */
export async function editSkippedTransactions(
  get: (key: string) => Promise<string | null>,
  set: (key: string, value: string) => Promise<void>,
  edit: (list: SkippedTransaction[]) => SkippedTransaction[],
): Promise<SkippedTransaction[]> {
  const parsed = parseSkippedTransactionsStrict(await get(SKIPPED_TRANSACTIONS_SECRET_KEY));
  if (parsed.kind === 'corrupt') throw new SkippedTransactionsUnreadableError();
  const next = edit(parsed.kind === 'ok' ? parsed.list : []);
  await set(SKIPPED_TRANSACTIONS_SECRET_KEY, JSON.stringify(next));
  return next;
}

export function withSkipped(list: SkippedTransaction[], entry: SkippedTransaction): SkippedTransaction[] {
  return list.some((s) => s.account === entry.account && s.txId === entry.txId) ? list : [...list, entry];
}

export function withoutSkipped(list: SkippedTransaction[], account: string, txId: string): SkippedTransaction[] {
  return list.filter((s) => !(s.account === account && s.txId === txId));
}
