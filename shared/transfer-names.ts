/**
 * shared/transfer-names.ts
 *
 * The learned transfer names (1.64, A1-A4): the wordings a bank uses for a
 * transfer between two of the user's own accounts, learned from transfers the
 * sync already linked. The companion computes the list from the database
 * (it is the only writer that can read every linked pair) and publishes it as
 * the `transfer_names` add-on secret; both writers' syncs read it and treat a
 * not-yet-linked row with a learned wording as a transfer leg.
 *
 * Why it exists, with live evidence (2026-10-18):
 *   - A savings -> PNC landing ("RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB
 *     PAYMENT") arrived first, matched no wording rule, and sat in the
 *     needs-a-category list until its partner leg showed up days later.
 *   - 360 Checking's "Withdrawal to 360 Performance Savings XXXXXX1580" matched
 *     no wording rule at all, although the same wording had been linked before.
 *
 * This module is imported by the sync core (Task 4), so it must NOT import
 * shared/sync-core.ts: it holds only the document shape, the signature and the
 * distinctiveness test. The learning itself lives in learn-transfer-names.ts.
 */
import { GENERIC_BANK_WORDS } from './category-guess.js';
import type { MappedType } from './mapper.js';

export const TRANSFER_NAMES_SECRET_KEY = 'transfer_names';
/** The list is capped so the secret stays small; newest names win. */
export const MAX_TRANSFER_NAMES = 500;

export type TransferDirection = 'in' | 'out';

export interface LearnedTransferName {
  /** The Wealthfolio account the leg sits in. */
  accountId: string;
  direction: TransferDirection;
  signature: string;
}

export interface TransferNames {
  version: 1;
  /** ISO time the companion computed the list. */
  computedAt: string;
  names: LearnedTransferName[];
}

/**
 * The letters-only words of a bank description (A2, R2). A reference changes
 * on every transfer (`RT08C248B2E7C8B`, `XXXXXX1580`, `*0082`, `REF#12AB`), so
 * every whitespace token holding a digit is dropped WHOLE, before anything is
 * split (splitting first would leave `REF` and `AB` behind). What is left is
 * lower-cased and split on every non-letter, so `WEB-RECUR` is two words.
 *
 *   RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT -> transfer capital one ach web payment
 *   *0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR            -> payment citi autopay ach web recur
 *   Withdrawal to 360 Performance Savings XXXXXX1580     -> withdrawal to performance savings
 */
export function transferSignature(bankText: string): string {
  const words: string[] = [];
  for (const token of bankText.split(/\s+/)) {
    if (!token || /\d/.test(token)) continue;
    for (const w of token.toLowerCase().split(/[^a-z]+/)) if (w) words.push(w);
  }
  return words.join(' ');
}

const NOT_DISTINCTIVE = new Set<string>([...GENERIC_BANK_WORDS, 'to', 'from', 'at', 'for']);

/** True when the signature has at least one word that says WHERE the money
 *  went (R3): "online transfer to" and "ach debit" fit every bank's transfers
 *  and many purchases, so they are never a name. */
export function isDistinctiveSignature(signature: string): boolean {
  return signature.split(' ').some((w) => w !== '' && !NOT_DISTINCTIVE.has(w));
}

/** Read the stored document. Null when absent, unreadable or another version;
 *  a malformed name is dropped rather than failing the whole list. */
export function parseTransferNames(raw: string | null | undefined): TransferNames | null {
  if (!raw) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null) return null;
  const d = doc as { version?: unknown; computedAt?: unknown; names?: unknown };
  if (d.version !== 1 || !Array.isArray(d.names)) return null;
  const names: LearnedTransferName[] = [];
  for (const n of d.names) {
    if (typeof n !== 'object' || n === null) continue;
    const { accountId, direction, signature } = n as Record<string, unknown>;
    if (typeof accountId !== 'string' || !accountId) continue;
    if (direction !== 'in' && direction !== 'out') continue;
    if (typeof signature !== 'string' || !signature) continue;
    names.push({ accountId, direction, signature });
  }
  return { version: 1, computedAt: typeof d.computedAt === 'string' ? d.computedAt : '', names };
}

const nameKey = (accountId: string, direction: TransferDirection, signature: string) => `${accountId}\u0000${direction}\u0000${signature}`;

/** The list as a lookup set of (account, direction, signature) keys. No list
 *  (no companion, or one not yet on 1.64) is the empty set, so typing is
 *  exactly what it was before (R6). */
export function learnedNameKeys(doc: TransferNames | null | undefined): Set<string> {
  const keys = new Set<string>();
  for (const n of doc?.names ?? []) keys.add(nameKey(n.accountId, n.direction, n.signature));
  return keys;
}

/** The transfer type a learned name gives a bank row, or null (A5). Only a
 *  known CASH account (R5: cards never learn or use names), only when no rule
 *  decided the type, only a plain built-in deposit/withdrawal in the listed
 *  direction, and only for a listed (account, direction, signature). */
export function learnedTransferType(
  names: ReadonlySet<string>,
  row: { wfAccountId: string; accountType: string | undefined; amount: number; mapped: MappedType; description: string },
): 'TRANSFER_IN' | 'TRANSFER_OUT' | null {
  if (names.size === 0 || row.accountType !== 'CASH' || row.mapped.fromRule) return null;
  let direction: TransferDirection;
  if (row.mapped.type === 'DEPOSIT' && row.amount > 0) direction = 'in';
  else if (row.mapped.type === 'WITHDRAWAL' && row.amount < 0) direction = 'out';
  else return null;
  if (!names.has(nameKey(row.wfAccountId, direction, transferSignature(row.description)))) return null;
  return direction === 'in' ? 'TRANSFER_IN' : 'TRANSFER_OUT';
}
