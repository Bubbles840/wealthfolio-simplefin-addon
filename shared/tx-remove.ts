/**
 * shared/tx-remove.ts
 *
 * "Remove for good…" on a transaction's story (2c R2, spec C2), for a row the
 * bank reported twice (live, 2026-10-09: PNC sent one $600 deposit in its old
 * and its new wording). Two taps: the first explains, the second removes.
 * Pure decisions and a host-neutral runner; each host lends its reads and
 * writes (companion/src/audit-fix-host.ts, src/utils/audit-fix.ts).
 *
 * Right before writing, the row is re-read, and nothing is written when it
 * changed since the story showed it, or it is: half of a linked transfer, or
 * may be (the add-on cannot always tell); a held transfer, a starting balance
 * or a correction (the sync manages those); not from the bank feed (no tx id,
 * or an account no feed maps to); or still pending — SimpleFin often gives a
 * pending transaction a new id when it posts (shared/reconcile.ts), so a
 * skipped pending id would not keep the posted copy out.
 *
 * Order (ruling Y3): the tx id goes on the skip list FIRST, through the
 * corrupt-safe edit, under every feed that maps to the row's account; then the
 * row is deleted. A delete that fails takes back off the list exactly the
 * keys this run added. The change entry keeps the row's full create payload:
 * Undo writes it back and takes the keys off the list, Redo removes it again
 * (shared/change-undo.ts). The log never costs the removal.
 */
import { isCorrectionNote, isPendingNote, isPlaceholderNote, isStartingBalanceNote } from './audit-ledger.js';
import { createPayloadOf } from './change-undo.js';
import { transactionRemovedChange, type ChangeDraft } from './change-entries.js';
import { isoDay, recreateWrite, type FixRow, type LinkedState } from './fix-row.js';
import { findingHandle } from './handle.js';
import { describeLeg } from './link-pair.js';
import { editSkippedTransactions, REMOVED_FOR_GOOD_NOTE, withoutSkipped, withSkipped, type SkippedTransaction } from './skipped-transactions.js';
import type { SecretGet, SecretSet } from './subscription-prefs.js';
import { descriptionFromComment, txIdFromComment } from './sync-core.js';
import { accountTxKey } from './transfers.js';
import { signedCents, type TxStoryFacts } from './tx-story.js';

export const REMOVE_ACTION = 'Remove for good…';
export const REMOVE_CONFIRM = 'Deletes this row and stops the bank feed importing it again. Undo puts it back.';
export const REMOVE_BUTTON = 'Remove';
export const REMOVE_CANCEL = 'Cancel';
export const REMOVE_DONE = "Removed. The bank feed won't import it again — Undo in the change log puts it back.";
export const REMOVE_CHANGED = 'It has changed since — nothing was removed.';
export const REMOVE_UNLINK_FIRST = 'Unlink it first.';
export const REMOVE_MANAGED = "The sync manages this row (a held transfer, a starting balance or a correction), so it can't be removed here.";
export const REMOVE_NOT_FEED = 'Only a transaction from your bank feed can be removed here.';
export const REMOVE_PENDING = "It's still pending — remove it once it posts.";
export const REMOVE_SKIP_UNREADABLE = "Couldn't save the skip list — nothing was changed.";
export const REMOVE_UNREACHABLE = "Couldn't reach Wealthfolio — nothing was removed.";
/** The note a skip-list entry written by a removal carries. */
export const REMOVE_SKIP_NOTE = REMOVED_FOR_GOOD_NOTE;

export const REMOVE_NO_UNDO = "Removed. The bank feed won't import it again, but the change log couldn't be written, so there's no Undo for it.";
export const REMOVE_NO_UNDO_POSSIBLE = "This one can't be removed here — Undo couldn't put it back.";
export const REMOVE_RUNNING = 'Already being removed — try again in a moment.';
export const removeUnsure = (cause: string, what: string) =>
  `Couldn't tell whether it was removed (${cause}). It stays on the skip list so it won't come back twice; if it's gone, it was: ${what}.`;

/** Activity ids being removed right now: a second run on the same id writes nothing. */
const inFlight = new Set<string>();

/** What a story showed of its row (shared/tx-story.ts `TxStoryRow`). */
export interface ShownRow {
  activityId: string;
  note: string;
  absCents: number;
  date: string;
  activityType: string;
  accountName: string;
}

/** The row as the story showed it, as the Remove button carries it: 8 hex.
 *  The date goes through the same `isoDay` the remover's read uses, so a
 *  story's raw date string and the re-read row agree in any format. */
export const removalFingerprint = (r: ShownRow): string =>
  findingHandle([r.activityId, r.accountName, r.absCents, isoDay(r.date), r.activityType.toUpperCase(), r.note].join('\u001f'));

const shownOf = (row: FixRow): ShownRow => ({
  activityId: row.id, note: row.notes, absCents: row.absCents, date: row.date, activityType: row.type, accountName: row.accountName,
});

const isManaged = (note: string) => isPlaceholderNote(note) || isStartingBalanceNote(note) || isCorrectionNote(note);

/** Whether a story offers "Remove for good…": a posted row from the bank
 *  feed, not one the sync manages, and not half of a transfer as far as the
 *  story knows. The second tap checks everything again. */
export function removalOffered(facts: TxStoryFacts): boolean {
  const note = facts.row.note ?? '';
  const failed = new Set(facts.failed ?? []);
  if (!facts.feed || failed.has('mapping') || failed.has('partner')) return false;
  if (!txIdFromComment(note) || isPendingNote(note) || isManaged(note)) return false;
  return facts.partner === null;
}

/** What a host lends the runner. */
export interface RemoveIo {
  /** The row by id, now; null when gone. Rejects when unreachable. */
  read(activityId: string): Promise<FixRow | null>;
  /** The SimpleFin accounts that sync into this Wealthfolio account ([] when
   *  none). Rejects when the mapping cannot be read. */
  feeds(wfAccountId: string): Promise<string[]>;
  /** Whether the row is half of a linked transfer, as sure as the host can be. */
  linked(row: FixRow, txKeys: string[]): Promise<LinkedState>;
  secrets: { get: SecretGet; set: SecretSet };
  /** Deletes the row; rejects when Wealthfolio refuses. */
  remove(activityId: string): Promise<void>;
  /** Appends to the change log through the host's own writer. */
  record(draft: ChangeDraft): Promise<void>;
  log(msg: string): void;
}

export interface RemoveOutcome {
  ok: boolean;
  message: string;
}

const refuse = (message: string): RemoveOutcome => ({ ok: false, message });
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The second tap. `fingerprint` is `removalFingerprint` of the row as the confirm screen showed it. */
export async function removeForGood(activityId: string, fingerprint: string, io: RemoveIo, now: Date): Promise<RemoveOutcome> {
  if (inFlight.has(activityId)) return refuse(REMOVE_RUNNING);
  inFlight.add(activityId);
  try {
    return await removeOnce(activityId, fingerprint, io, now);
  } finally {
    inFlight.delete(activityId);
  }
}

async function removeOnce(activityId: string, fingerprint: string, io: RemoveIo, now: Date): Promise<RemoveOutcome> {
  let row: FixRow | null;
  let txId: string | null;
  let feeds: string[];
  try {
    row = await io.read(activityId);
    if (!row || removalFingerprint(shownOf(row)) !== fingerprint) return refuse(REMOVE_CHANGED);
    if (isManaged(row.notes)) return refuse(REMOVE_MANAGED);
    txId = txIdFromComment(row.notes);
    feeds = txId ? await io.feeds(row.accountId) : [];
    if (!txId || feeds.length === 0) return refuse(REMOVE_NOT_FEED);
    if (isPendingNote(row.notes)) return refuse(REMOVE_PENDING);
    if (row.grouped || await io.linked(row, feeds.map((f) => accountTxKey(f, txId!)))) return refuse(REMOVE_UNLINK_FIRST);
  } catch (err) {
    io.log(`Remove ${activityId}: ${errorText(err)}`);
    return refuse(REMOVE_UNREACHABLE);
  }
  const id = txId;
  const keys = feeds.map((f) => accountTxKey(f, id));
  const payload = { ...recreateWrite(row) };
  // Undo could not put a row back that createPayloadOf refuses: refuse before any write.
  if (!createPayloadOf(payload)) return refuse(REMOVE_NO_UNDO_POSSIBLE);

  // 1. The skip list first. Only what this run adds is ever taken back.
  let added: SkippedTransaction[] = [];
  try {
    await editSkippedTransactions(io.secrets.get, io.secrets.set, (list) => {
      added = feeds
        .filter((f) => !list.some((s) => s.account === f && s.txId === id))
        .map((f) => ({ account: f, txId: id, note: REMOVE_SKIP_NOTE, at: now.toISOString() }));
      return added.reduce(withSkipped, list);
    });
  } catch (err) {
    io.log(`Remove ${activityId}: the skip list was not saved: ${errorText(err)}`);
    return refuse(REMOVE_SKIP_UNREADABLE);
  }

  // 2. Then the row.
  try {
    await io.remove(row.id);
  } catch (err) {
    const why = errorText(err);
    io.log(`Remove ${activityId}: the delete failed: ${why}`);
    // The response may have been lost after the delete landed: look again before deciding.
    let still: FixRow | null | undefined;
    try {
      still = await io.read(row.id);
    } catch (again) {
      io.log(`Remove ${activityId}: could not tell whether it was removed (${errorText(again)}): ${JSON.stringify({ keys, payload })}`);
      return refuse(removeUnsure(errorText(again), describeLeg({
        accountId: row.accountId, accountName: row.accountName, date: row.date, absCents: row.absCents, comment: row.notes,
      })));
    }
    if (still) {
      try {
        if (added.length > 0) {
          await editSkippedTransactions(io.secrets.get, io.secrets.set, (list) => added.reduce((l, s) => withoutSkipped(l, s.account, s.txId), list));
        }
      } catch (again) {
        io.log(`Remove ${activityId}: taking it back off the skip list failed: ${errorText(again)}`);
        return refuse(`Couldn't remove it (${why}), and it stays on the skip list — the bank feed won't import it again until it's taken off.`);
      }
      return refuse(`Couldn't remove it (${why}) — nothing was changed.`);
    }
  }

  // 3. The change log, which never costs the removal.
  try {
    await io.record(transactionRemovedChange({
      account: { sfinId: feeds[0], wfId: row.accountId, name: row.accountName },
      txKeys: keys,
      addedKeys: added.map((s) => accountTxKey(s.account, s.txId)),
      activityId: row.id,
      description: descriptionFromComment(row.notes),
      amountCents: signedCents({ absCents: row.absCents, activityType: row.type, accountType: row.accountType }),
      date: row.date,
      payload,
    }));
  } catch (err) {
    io.log(`Remove ${activityId}: removed, but the change log was not written: ${errorText(err)}: ${JSON.stringify({ keys, payload })}`);
    return { ok: true, message: REMOVE_NO_UNDO };
  }
  return { ok: true, message: REMOVE_DONE };
}
