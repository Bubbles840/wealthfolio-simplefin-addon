/**
 * shared/payback.ts
 *
 * Paybacks (1.62.0, W6–W10): a deposit that pays you back for spending — a
 * friend's Venmo for dinner — filed against that spending. Since 3.9,
 * Wealthfolio decides which categories a row can take from the row's type: a
 * cash DEPOSIT is income, and only a CREDIT marked REIMBURSEMENT (REFUND,
 * REBATE) comes off spending (`classify_activity`,
 * crates/spending/src/activity_classification.rs:98-130 at 3.8.0/3.9.0,
 * :100-132 at 3.10.0). So filing a payback re-types the row before it files
 * it:
 *
 *  1. the `asReimbursement` override, under every feed of the row's account,
 *     through `editSyncOverrides` (which re-reads right before it writes), so
 *     the sync keeps the row a payback instead of reverting it (W7);
 *  2. the row: a CREDIT marked REIMBURSEMENT, everything else as stored — its
 *     date written back as the very instant Wealthfolio holds, so a retype
 *     never moves a row to another day;
 *  3. the spending category;
 *  4. a `payback-filed` change-log entry, whose Undo reverses all three.
 *
 * `planPayback` decides from facts re-read right before writing; a refusal
 * writes nothing and says why in its own words. Pure. `filePayback` runs a
 * plan on a host (companion/src/payback-host.ts lends the companion's REST
 * reads and writes) and, when a later step fails, says plainly what stands.
 */
import { isCorrectionNote, isPendingNote, isPlaceholderNote, isStartingBalanceNote } from './audit-ledger.js';
import { REIMBURSEMENT_SUBTYPE } from './cash-flow-bucket.js';
import { paybackFiledChange, type ChangeDraft, type PaybackFiledFacts } from './change-entries.js';
import { fixRowOf } from './fix-row.js';
import {
  PAYBACK_ALREADY, PAYBACK_GONE, PAYBACK_LINKED, PAYBACK_MANAGED, PAYBACK_NO_UNDO, PAYBACK_NOT_CASH, PAYBACK_NOT_DEPOSIT, PAYBACK_NOT_FEED,
  PAYBACK_OVERRIDE_FAILED, PAYBACK_PENDING, PAYBACK_RUNNING, PAYBACK_TRANSFER, PAYBACK_UNDO_HINT, PAYBACK_UNREACHABLE, PAYBACK_UPDATE_ADDON,
  PAYBACK_UPDATE_REFUSED, PAYBACK_UPDATE_STUCK, PAYBACK_UPDATE_UNSURE, PAYBACK_ZERO, paybackDone, paybackUnfiled,
} from './payback-copy.js';
import { isPaybackRow, paybackRetype, type PaybackRow } from './payback-row.js';
import type { SecretGet, SecretSet } from './subscription-prefs.js';
import { descriptionFromComment, isTransferType, txIdFromComment } from './sync-core.js';
import type { ActivityWrite } from './sync-host.js';
import {
  clearTxOverride, editSyncOverrides, hasTxOverride, isUnreadableOverridesError, loadSyncOverrides, setTxOverride,
  SYNC_OVERRIDES_UNREADABLE_MESSAGE, type LoadedSyncOverrides,
} from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import { addonUnderstandsPaybacks, INSTALLED_ADDON_VERSION_SECRET_KEY } from './version.js';

/** An ActivityDetails row as a payback reads it; null when the fixes' reader
 *  refuses it (no id, account, type, date or currency). */
export function paybackRowOf(raw: unknown, accountType: string): PaybackRow | null {
  const row = fixRowOf(raw, accountType);
  if (!row) return null;
  const at = (raw as { date?: unknown }).date;
  return { ...row, instant: typeof at === 'string' && at.trim() !== '' ? at.trim() : row.date };
}

/** What `planPayback` decides from, all re-read right before the write. */
export interface PaybackFacts {
  /** The row by exact id; null when gone. */
  row: PaybackRow | null;
  /** The SimpleFin accounts that sync into the row's account ([] when none). */
  feeds: string[];
  /** `loadSyncOverrides`, as just read. */
  overrides: LoadedSyncOverrides;
  /** The spending category picked. */
  category: { id: string; name: string };
}

/** What a payback writes, in order. */
export interface PaybackWrites {
  /** The row's key under every feed of its account: `asReimbursement` goes on each. */
  txKeys: string[];
  /** The overrides list's words for it: "<bank text> · <account>". */
  label: string;
  /** The row as a CREDIT marked REIMBURSEMENT. */
  update: ActivityWrite;
  /** The spending category. */
  assign: { activityId: string; categoryId: string };
  /** The change-log entry's facts (`paybackFiledChange`). */
  entry: PaybackFiledFacts;
}

export type PaybackPlan = { ok: true; writes: PaybackWrites } | { ok: false; reason: string };

const no = (reason: string): PaybackPlan => ({ ok: false, reason });

/**
 * Decide a payback. Refused, each in its own words and with nothing written:
 * a row that is gone; one the sync manages (a held transfer, a starting
 * balance, a correction); one not from the bank feed (no tx id, or an account
 * no feed maps to — the override needs a key the sync reads); half of a
 * linked transfer; a transfer; a pending row (SimpleFin often gives it a new
 * id when it posts, which the override would not follow); a row outside a
 * cash account (on a card every CREDIT already comes off spending); one that
 * is already a payback (by its type or its override); anything but a
 * DEPOSIT; a row whose stored amount is not positive; and an overrides document that cannot be read (never overwritten).
 */
export function planPayback(f: PaybackFacts): PaybackPlan {
  const row = f.row;
  if (!row) return no(PAYBACK_GONE);
  if (isPlaceholderNote(row.notes) || isStartingBalanceNote(row.notes) || isCorrectionNote(row.notes)) return no(PAYBACK_MANAGED);
  const txId = txIdFromComment(row.notes);
  if (!txId || f.feeds.length === 0) return no(PAYBACK_NOT_FEED);
  if (row.grouped) return no(PAYBACK_LINKED);
  if (isTransferType(row.type)) return no(PAYBACK_TRANSFER);
  if (isPendingNote(row.notes)) return no(PAYBACK_PENDING);
  if (row.accountType !== 'CASH') return no(PAYBACK_NOT_CASH);
  const txKeys = f.feeds.map((sfin) => accountTxKey(sfin, txId));
  if (isPaybackRow(row) || txKeys.some((k) => hasTxOverride(f.overrides.overrides, k, 'asReimbursement'))) return no(PAYBACK_ALREADY);
  if (row.type !== 'DEPOSIT') return no(PAYBACK_NOT_DEPOSIT);
  if (!(row.absCents > 0)) return no(PAYBACK_ZERO);
  if (f.overrides.unreadable) return no(SYNC_OVERRIDES_UNREADABLE_MESSAGE);
  const description = descriptionFromComment(row.notes);
  const what = description || 'a transaction';
  return {
    ok: true,
    writes: {
      txKeys,
      label: row.accountName ? `${what} · ${row.accountName}` : what,
      update: paybackRetype(row, 'CREDIT', REIMBURSEMENT_SUBTYPE),
      assign: { activityId: row.id, categoryId: f.category.id },
      entry: {
        account: { sfinId: f.feeds[0], wfId: row.accountId, name: row.accountName },
        txKeys,
        activityId: row.id,
        description,
        amountCents: row.absCents,
        date: row.date,
        subtypeBefore: row.subtype,
        categoryId: f.category.id,
        categoryName: f.category.name,
      },
    },
  };
}

// ── Filing: the runner ───────────────────────────────────────────────────

/** What a host lends `filePayback`. */
export interface PaybackIo {
  /** Why this host may not file a payback now (a version gate, W8), or null. Never rejects. */
  gate(): Promise<string | null>;
  /** The row by exact id, now; null when gone. Rejects when unreachable. */
  read(activityId: string): Promise<PaybackRow | null>;
  /** The SimpleFin accounts that sync into this Wealthfolio account. Rejects when unreadable. */
  feeds(wfAccountId: string): Promise<string[]>;
  secrets: { get: SecretGet; set: SecretSet };
  /** One update through the bulk endpoint; rejects when Wealthfolio refuses it. */
  update(write: ActivityWrite): Promise<void>;
  /** Files the row under a spending category; rejects when Wealthfolio refuses. */
  assign(activityId: string, categoryId: string): Promise<void>;
  /** Appends to the change log through the host's own writer. */
  record(draft: ChangeDraft): Promise<void>;
  log(msg: string): void;
}

/** The tap: the row, and the spending category picked. */
export interface PaybackChoice {
  activityId: string;
  categoryId: string;
  categoryName: string;
  /** The category's parent, whose spending it comes off (`Food & Dining` for
   *  Restaurants); null for a top-level category. */
  parentName: string | null;
}

/** `filed`: all of it. `partial`: something changed, but not all of it — the
 *  message says what stands. `refused`: nothing was written. */
export type PaybackOutcome =
  | { kind: 'filed'; message: string }
  | { kind: 'partial'; message: string }
  | { kind: 'refused'; message: string };

/** The companion's gate (W8): an INSTALLED add-on of PAYBACK_SINCE or newer.
 *  Unknown — nothing written, or the read failed — refuses too. */
export async function addonPaybackGate(get: SecretGet): Promise<string | null> {
  let installed: string | null;
  try {
    installed = await get(INSTALLED_ADDON_VERSION_SECRET_KEY);
  } catch {
    installed = null;
  }
  return addonUnderstandsPaybacks(installed && installed.trim() ? installed : null) ? null : PAYBACK_UPDATE_ADDON;
}

/** Activity ids being filed right now: a second tap on the same row writes nothing. */
const inFlight = new Set<string>();
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * File one deposit as a payback: gate, re-read, plan, then the override, the
 * row, the category and the log, in that order. What a failure leaves:
 *  - the override not saved: nothing changed;
 *  - the row refused: read again — still a deposit, the override this run
 *    added comes back off ("nothing was changed"), or, when that write fails
 *    too, the next sync makes it a payback; can't tell, the override stays
 *    and says so; a payback after all (a lost response), carry on;
 *  - the category refused: a payback with no category, which /categorize
 *    offers again — logged, so Undo can still turn it back into a deposit;
 *  - the log not written: all done, without an Undo.
 * Wealthfolio's own error text goes to the host's log, never to the message.
 */
export async function filePayback(choice: PaybackChoice, io: PaybackIo, now: Date): Promise<PaybackOutcome> {
  if (inFlight.has(choice.activityId)) return { kind: 'refused', message: PAYBACK_RUNNING };
  inFlight.add(choice.activityId);
  try {
    return await fileOnce(choice, io, now);
  } finally {
    inFlight.delete(choice.activityId);
  }
}

async function fileOnce(choice: PaybackChoice, io: PaybackIo, now: Date): Promise<PaybackOutcome> {
  const refused = (message: string): PaybackOutcome => ({ kind: 'refused', message });
  const gate = await io.gate().catch(() => PAYBACK_UPDATE_ADDON);
  if (gate) return refused(gate);

  let row: PaybackRow | null;
  let plan: PaybackPlan;
  try {
    row = await io.read(choice.activityId);
    const feeds = row ? await io.feeds(row.accountId) : [];
    const overrides = await loadSyncOverrides(io.secrets.get);
    plan = planPayback({ row, feeds, overrides, category: { id: choice.categoryId, name: choice.categoryName } });
  } catch (err) {
    io.log(`Payback ${choice.activityId}: ${errorText(err)}`);
    return refused(PAYBACK_UNREACHABLE);
  }
  if (!plan.ok) return refused(plan.reason);
  const w = plan.writes;
  const absCents = row!.absCents;

  // 1. The override, re-read right before it is written. Only what this run adds is ever taken back.
  let added: string[] = [];
  try {
    await editSyncOverrides(io.secrets.get, io.secrets.set, (o) => {
      added = w.txKeys.filter((k) => !hasTxOverride(o, k, 'asReimbursement'));
      return w.txKeys.reduce((d, k) => setTxOverride(d, k, 'asReimbursement', now, { label: w.label }), o);
    }, now);
  } catch (err) {
    io.log(`Payback ${choice.activityId}: the override was not saved: ${errorText(err)}`);
    return refused(isUnreadableOverridesError(err) ? SYNC_OVERRIDES_UNREADABLE_MESSAGE : PAYBACK_OVERRIDE_FAILED);
  }

  // 2. The row. A refused update is read again: its response can be lost after it landed.
  try {
    await io.update(w.update);
  } catch (err) {
    io.log(`Payback ${choice.activityId}: the update failed: ${errorText(err)}`);
    let again: PaybackRow | null;
    try {
      again = await io.read(choice.activityId);
    } catch (readErr) {
      io.log(`Payback ${choice.activityId}: could not tell whether the update landed: ${errorText(readErr)}`);
      return { kind: 'partial', message: PAYBACK_UPDATE_UNSURE };
    }
    if (!again || !isPaybackRow(again)) {
      try {
        if (added.length > 0) {
          await editSyncOverrides(io.secrets.get, io.secrets.set, (o) => added.reduce((d, k) => clearTxOverride(d, k, 'asReimbursement'), o), now);
        }
      } catch (undoErr) {
        io.log(`Payback ${choice.activityId}: taking the override back failed: ${errorText(undoErr)}`);
        return { kind: 'partial', message: PAYBACK_UPDATE_STUCK };
      }
      return refused(PAYBACK_UPDATE_REFUSED);
    }
  }

  // 3. The category.
  let filed = true;
  try {
    await io.assign(w.assign.activityId, w.assign.categoryId);
  } catch (err) {
    filed = false;
    io.log(`Payback ${choice.activityId}: filing it under ${choice.categoryId} failed: ${errorText(err)}`);
  }

  // 4. The change log, which never costs the payback.
  const entry = filed ? w.entry : { ...w.entry, categoryId: null, categoryName: null };
  let logged = true;
  try {
    await io.record(paybackFiledChange(entry));
  } catch (err) {
    logged = false;
    io.log(`Payback ${choice.activityId}: filed, but the change log was not written: ${errorText(err)}: ${JSON.stringify(entry)}`);
  }
  const tail = logged ? PAYBACK_UNDO_HINT : PAYBACK_NO_UNDO;
  return filed
    ? { kind: 'filed', message: `${paybackDone(choice.categoryName, choice.parentName ?? choice.categoryName, absCents)}\n${tail}` }
    : { kind: 'partial', message: `${paybackUnfiled(choice.categoryName)}\n${tail}` };
}
