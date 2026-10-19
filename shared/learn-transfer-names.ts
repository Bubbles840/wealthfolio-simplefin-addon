/**
 * shared/learn-transfer-names.ts
 *
 * Learning the transfer names (A1, A3) from the ledger the companion reads.
 * A leg teaches only when it is the real bank text of one leg of a transfer
 * the sync linked between two accounts: that is the one place the add-on KNOWS
 * a wording means "money between my own accounts". One past link is enough
 * (R1) - 360 Checking's `Withdrawal to 360 Performance Savings XXXXXX1580`
 * was linked once and still matched no rule on 2026-10-18.
 *
 * What never teaches: the sync's own bookkeeping rows, in-transit placeholders,
 * a row typed by hand (no `· <txId>` tail), card accounts (R5: a card payment
 * is a payback, handled elsewhere), a group whose two legs carry the same note
 * (R12: that is one bank line copied, not two wordings of a transfer), a
 * signature with no distinctive word (R3), and any wording the user undid with
 * `notTransfer` on that account (R4, both directions).
 */
import type { AuditLedger } from './audit-ledger.js';
import { typeCashSign } from './audit-ledger.js';
import { bankWords } from './rule-pattern.js';
import { descriptionFromComment, isInternalMarkerComment, IN_TRANSIT_COMMENT_PREFIX, txIdFromComment } from './sync-core.js';
import { hasTxOverride, type SyncOverrides } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import type { AccountMapping } from './types.js';
import {
  MAX_TRANSFER_NAMES, isDistinctiveSignature, transferSignature,
  type LearnedTransferName, type TransferNames,
} from './transfer-names.js';

/** Only the last year teaches: wordings change when a bank re-words its feed. */
export const TRANSFER_NAMES_LOOKBACK_DAYS = 365;

/** The signature of a STORED note: the sync's id / pending marker / in-transit
 *  prefix, and the Venmo note or Amazon label it appended, come off first. */
export function noteSignature(notes: string): string {
  return transferSignature(bankWords(descriptionFromComment(notes)));
}

export function learnTransferNames(input: {
  ledger: AuditLedger;
  mapping: AccountMapping;
  overrides: SyncOverrides;
  now: Date;
}): TransferNames {
  const { ledger, mapping, overrides, now } = input;
  const since = new Date(now.getTime() - TRANSFER_NAMES_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const accountType = new Map(ledger.accounts.map((a) => [a.id, (a.type ?? '').toUpperCase()]));
  const sfinIdsOf = new Map<string, string[]>();
  for (const [sfinId, wfId] of Object.entries(mapping)) {
    const list = sfinIdsOf.get(wfId) ?? [];
    list.push(sfinId);
    sfinIdsOf.set(wfId, list);
  }

  // R4: one notTransfer on any row with that wording on that account blocks it.
  const blocked = new Set<string>();
  for (const r of ledger.rows) {
    const txId = txIdFromComment(r.notes);
    if (!txId) continue;
    const undone = (sfinIdsOf.get(r.accountId) ?? []).some((s) => hasTxOverride(overrides, accountTxKey(s, txId), 'notTransfer'));
    if (undone) blocked.add(`${r.accountId}\u0000${noteSignature(r.notes)}`);
  }

  const groups = new Map<string, typeof ledger.rows>();
  for (const r of ledger.rows) {
    if (!r.group) continue;
    const list = groups.get(r.group) ?? [];
    list.push(r);
    groups.set(r.group, list);
  }

  const learned = new Map<string, LearnedTransferName & { date: string }>();
  for (const legs of groups.values()) {
    // R12: identical notes on legs of different accounts teach nothing.
    const sameNote = legs.some((a) => legs.some((b) => a.accountId !== b.accountId && a.notes.trim() === b.notes.trim()));
    if (sameNote) continue;
    for (const r of legs) {
      if (r.date < since) continue;
      if (!legs.some((o) => o.accountId !== r.accountId)) continue;
      const type = accountType.get(r.accountId) ?? '';
      if (type === 'CREDIT_CARD') continue;
      if (isInternalMarkerComment(r.notes) || r.notes.startsWith(IN_TRANSIT_COMMENT_PREFIX) || !txIdFromComment(r.notes)) continue;
      const sign = typeCashSign(r.type, type);
      if (sign === 0) continue;
      const signature = noteSignature(r.notes);
      if (!isDistinctiveSignature(signature) || blocked.has(`${r.accountId}\u0000${signature}`)) continue;
      const direction = sign > 0 ? 'in' : 'out';
      const key = `${r.accountId}\u0000${direction}\u0000${signature}`;
      const seen = learned.get(key);
      if (!seen || r.date > seen.date) learned.set(key, { accountId: r.accountId, direction, signature, date: r.date });
    }
  }

  const names = [...learned.values()]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, MAX_TRANSFER_NAMES)
    .map(({ accountId, direction, signature }) => ({ accountId, direction, signature }));
  return { version: 1, computedAt: now.toISOString(), names };
}
