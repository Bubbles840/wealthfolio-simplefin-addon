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
import { REIMBURSEMENT_SUBTYPE, SPENDING_TAXONOMY_ID } from './cash-flow-bucket.js';
import {
  categoryRuleCreatedChange, mappingRuleCreatedChange, paybackFiledChange, type ChangeDraft, type PaybackFiledFacts,
} from './change-entries.js';
import { MAPPING_RULES_SECRET_KEY, UNDO_MAPPING_RULES_UNREADABLE } from './change-undo-run.js';
import { fixRowOf } from './fix-row.js';
import { BANK_TRANSFER_KEYWORDS, mapTransactionWithSource, paybackMappingRule, ruleApplies, sameMappingRule } from './mapper.js';
import { bankWords } from './rule-pattern.js';
import {
  PAYBACK_ALREADY, PAYBACK_CHANGED, PAYBACK_GONE, PAYBACK_GONE_STUCK, PAYBACK_LINKED, PAYBACK_MANAGED, PAYBACK_MAPPING_UNREADABLE, PAYBACK_NO_UNDO, PAYBACK_NO_UNDO_SETTING, PAYBACK_NOT_CASH, PAYBACK_NOT_DEPOSIT, PAYBACK_NOT_FEED,
  PAYBACK_OVERRIDE_FAILED, PAYBACK_OVERRIDE_UNSURE, PAYBACK_PENDING, PAYBACK_RULES_EXIST, PAYBACK_RULES_GENERIC, PAYBACK_RULES_REFUSED, PAYBACK_RULES_SHADOWED, PAYBACK_RULES_UNSURE, PAYBACK_RULES_SAVE_FAILED, PAYBACK_RULES_TRANSFER_ROWS, PAYBACK_RULES_TRANSFER_WORDS, PAYBACK_RUNNING, PAYBACK_SETTING_HINT, PAYBACK_TRANSFER, PAYBACK_UNDO_HINT, PAYBACK_UNREACHABLE, PAYBACK_UPDATE_ADDON,
  PAYBACK_UPDATE_REFUSED, PAYBACK_UPDATE_STUCK, PAYBACK_UPDATE_UNSURE, PAYBACK_ZERO, paybackDone, paybackRulesBehind, paybackRulesConflict, paybackRulesDone, paybackRulesTakesOver, paybackRulesStuck, paybackUnfiled,
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
import type { MappingRule } from './types.js';
import { removalFingerprint, RemoveMappingUnreadableError } from './tx-remove.js';
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
  /** Why this host may not file a payback now (a version gate, W8), or null.
   *  Rejects when it cannot tell (the add-on's secrets are unreadable). */
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
  /** The spending category the row is filed under now, or null; read-only. Rejects when unreadable.
   *  Optional: a host without it treats a refused filing as not filed (PB-B, M3). */
  assigned?(activityId: string): Promise<string | null>;
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
  /** `removalFingerprint` of the row as the menu showed it (PB-B, M1). Absent: no check. */
  shown?: string;
}

/** `filed`: all of it. `partial`: something changed, but not all of it — the
 *  message says what stands. `refused`: nothing was written. */
export type PaybackOutcome =
  | { kind: 'filed'; message: string }
  | { kind: 'partial'; message: string }
  | { kind: 'refused'; message: string };

/** The companion's gate (W8): an INSTALLED add-on of PAYBACK_SINCE or newer.
 *  Unknown — nothing written — refuses too. A read that fails REJECTS: that is
 *  "couldn't reach", not "too old" (PB-B, M7). */
export async function addonPaybackGate(get: SecretGet): Promise<string | null> {
  const installed = await get(INSTALLED_ADDON_VERSION_SECRET_KEY);
  return addonUnderstandsPaybacks(installed && installed.trim() ? installed : null) ? null : PAYBACK_UPDATE_ADDON;
}

/** Activity ids being filed right now: a second tap on the same row writes nothing. */
const inFlight = new Set<string>();
const paybackFingerprint = (r: PaybackRow): string => removalFingerprint({
  activityId: r.id, note: r.notes, absCents: r.absCents, date: r.date, activityType: r.type, accountName: r.accountName,
});
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * File one deposit as a payback: gate, re-read, plan, then the override, the
 * row, the category and the log, in that order. What a failure leaves:
 *  - the override not saved: nothing changed;
 *  - the row refused: read again — still a deposit, the override this run
 *    added comes back off ("nothing was changed"), or, when that write fails
 *    too, the next sync makes it a payback; can't tell, the override stays
 *    and says so; a payback after all (a lost response), carry on;
 *  - the category refused: read again — filed after all (a lost response),
 *    carry on; else a payback with no category, which /categorize
 *    offers again — logged, so Undo can still turn it back into a deposit;
 *  - the log not written: all done, without an Undo.
 * PB-B: a `shown` fingerprint that no longer matches the re-read row refuses
 * with nothing written; an override write that failed but landed carries on; a
 * setting left on a possibly-unfiled row is logged with no category (Undo takes
 * it off); a row gone on the re-read is said to be gone.
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
  let gate: string | null;
  try {
    gate = await io.gate();
  } catch (err) {
    io.log(`Payback ${choice.activityId}: could not read the installed add-on version: ${errorText(err)}`);
    return refused(PAYBACK_UNREACHABLE);
  }
  if (gate) return refused(gate);

  let row: PaybackRow | null;
  let plan: PaybackPlan;
  try {
    row = await io.read(choice.activityId);
    // What the menu showed is what is written (PB-B, M1); absent, no check.
    if (row && choice.shown !== undefined && choice.shown !== paybackFingerprint(row)) return refused(PAYBACK_CHANGED);
    const feeds = row ? await io.feeds(row.accountId) : [];
    const overrides = await loadSyncOverrides(io.secrets.get);
    plan = planPayback({ row, feeds, overrides, category: { id: choice.categoryId, name: choice.categoryName } });
  } catch (err) {
    io.log(`Payback ${choice.activityId}: ${errorText(err)}`);
    return refused(err instanceof RemoveMappingUnreadableError ? PAYBACK_MAPPING_UNREADABLE : PAYBACK_UNREACHABLE);
  }
  if (!plan.ok) return refused(plan.reason);
  const w = plan.writes;
  const absCents = row!.absCents;

  // The payback setting stays on a row that may not be a payback: logged with no category, so Undo takes it off (PB-B, M5).
  const unconfirmed = async (message: string): Promise<PaybackOutcome> => {
    let logged = true;
    try {
      await io.record(paybackFiledChange({ ...w.entry, categoryId: null, categoryName: null }));
    } catch (err) {
      logged = false;
      io.log(`Payback ${choice.activityId}: the payback setting stays, but the change log was not written: ${errorText(err)}`);
    }
    return { kind: 'partial', message: `${message}\n${logged ? PAYBACK_SETTING_HINT : PAYBACK_NO_UNDO_SETTING}` };
  };

  // 1. The override, re-read right before it is written. Only what this run adds is ever taken back.
  let added: string[] = [];
  try {
    await editSyncOverrides(io.secrets.get, io.secrets.set, (o) => {
      added = w.txKeys.filter((k) => !hasTxOverride(o, k, 'asReimbursement'));
      return w.txKeys.reduce((d, k) => setTxOverride(d, k, 'asReimbursement', now, { label: w.label }), o);
    }, now);
  } catch (err) {
    io.log(`Payback ${choice.activityId}: the override was not saved: ${errorText(err)}`);
    if (isUnreadableOverridesError(err)) return refused(SYNC_OVERRIDES_UNREADABLE_MESSAGE);
    // The write can fail after it landed (a lost response): read it again (PB-B, M2).
    let landed = false;
    let unsure = false;
    try {
      const now2 = await loadSyncOverrides(io.secrets.get);
      landed = !now2.unreadable && w.txKeys.every((k) => hasTxOverride(now2.overrides, k, 'asReimbursement'));
    } catch (readErr) {
      unsure = true;
      io.log(`Payback ${choice.activityId}: could not read the overrides again: ${errorText(readErr)}`);
    }
    if (unsure && added.length > 0) {
      // Whether it landed is unknown: take back what this run added; if that fails too, the setting may be on.
      try {
        await editSyncOverrides(io.secrets.get, io.secrets.set, (o) => added.reduce((d, k) => clearTxOverride(d, k, 'asReimbursement'), o), now);
      } catch (undoErr) {
        io.log(`Payback ${choice.activityId}: taking the override back failed: ${errorText(undoErr)}`);
        return unconfirmed(PAYBACK_OVERRIDE_UNSURE);
      }
    }
    if (!landed) return refused(PAYBACK_OVERRIDE_FAILED);
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
      return unconfirmed(PAYBACK_UPDATE_UNSURE);
    }
    if (!again || !isPaybackRow(again)) {
      try {
        if (added.length > 0) {
          await editSyncOverrides(io.secrets.get, io.secrets.set, (o) => added.reduce((d, k) => clearTxOverride(d, k, 'asReimbursement'), o), now);
        }
      } catch (undoErr) {
        io.log(`Payback ${choice.activityId}: taking the override back failed: ${errorText(undoErr)}`);
        if (!again) return { kind: 'partial', message: PAYBACK_GONE_STUCK };
        return unconfirmed(PAYBACK_UPDATE_STUCK);
      }
      return refused(again ? PAYBACK_UPDATE_REFUSED : PAYBACK_GONE);
    }
  }

  // 3. The category.
  let filed = true;
  try {
    await io.assign(w.assign.activityId, w.assign.categoryId);
  } catch (err) {
    filed = false;
    io.log(`Payback ${choice.activityId}: filing it under ${choice.categoryId} failed: ${errorText(err)}`);
    // The assignment can land and its response be lost: read it again, and treat a landed filing as done (PB-B, M3).
    if (io.assigned) {
      try {
        filed = (await io.assigned(choice.activityId)) === choice.categoryId;
      } catch (readErr) {
        io.log(`Payback ${choice.activityId}: could not tell whether the filing landed: ${errorText(readErr)}`);
      }
    }
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

// ── "Make every … deposit a payback" (W10) ───────────────────────────────

/** The priority the category rule is made at: Wealthfolio applies the highest first, and /categorize's rules use it too. */
export const PAYBACK_RULE_PRIORITY = 50;

/** What the rules are called in Wealthfolio's rules list (the pattern is never cut). */
export const PAYBACK_RULE_NAME_PREFIX = 'Telegram payback: ';
const RULE_NAME_MAX = 60;

/** The offer, as the Filed screen makes it. */
export interface PaybackRulesInput {
  /** `paybackRulePattern` of the deposit's description. */
  pattern: string;
  /** The deposit's Wealthfolio account: both rules read only it. */
  account: { id: string; name: string };
  categoryId: string;
  categoryName: string;
  /** The deposit it was made from, for the change log. */
  description: string;
  /** The deposit's activity id: the transfer check leaves it out. Optional. */
  sourceId?: string;
  /** Category names by id, to name another category in a conflict. Optional. */
  categories?: Array<{ id: string; name: string }>;
}

/** What a host lends `makePaybackRules`. */
export interface PaybackRulesIo {
  /** As `PaybackIo.gate`: an older add-on would read the transaction rule without its limits. */
  gate(): Promise<string | null>;
  secrets: { get: SecretGet; set: SecretSet };
  /** Wealthfolio's categorization rules now. Rejects when unreachable. */
  /** The account's money-in rows of the last 90 days, for the transfer check. Optional; rejects when unreadable. */
  breadthRows?(accountId: string): Promise<PaybackBreadthRow[]>;
  categoryRules(): Promise<Array<{
    id: string; pattern: string; categoryId: string | null; accountId?: string; activityType?: string;
    /** For the broader-rule check (M3); a rule without them is judged as a plain contains rule at priority 0. */
    priority?: number; matchType?: string; taxonomyId?: string; amountOp?: string;
  }>>;
  /** Creates a contains rule for one account and one activity type; resolves its id (null when the reply named none). */
  createCategoryRule(rule: { name: string; pattern: string; categoryId: string; accountId: string; activityType: string }): Promise<string | null>;
  /** Appends to the change log; rejects when THIS entry was not written (the reply then promises no Undo). */
  record(draft: ChangeDraft): Promise<void>;
  log(msg: string): void;
}

export interface PaybackRulesOutcome {
  ok: boolean;
  message: string;
}

/** Words so common in a bank's wording that a rule made only of them would catch deposits that are not paybacks. */
const GENERIC_BANK_WORDS: ReadonlySet<string> = new Set([
  'DEPOSIT', 'MOBILE', 'CREDIT', 'ACH', 'TRANSFER', 'ONLINE', 'DIRECT', 'CHECK', 'FROM', 'TO', 'REF', 'PAYMENT',
  'PPD', 'WEB', 'ID',
  'ATM', 'BRANCH', 'REMOTE', 'WIRE', 'INCOMING', 'DEP', 'EDEPOSIT', 'XFER', 'SAVINGS', 'BANK', 'EFT', 'IN', 'ON',
]);

/** The `since` of a rule made at `now`: the day BEFORE its UTC day, so a deposit
 *  of the same evening (already the next UTC day) is never missed on a re-import. */
export const paybackRuleSince = (now: Date): string => new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);

/** A pattern needs at least one word that is not generic bank wording (and not a number); else the plain refusal. */
export function paybackPatternRefusal(pattern: string): string | null {
  const words = pattern.toUpperCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.some((w) => /\p{L}/u.test(w) && !GENERIC_BANK_WORDS.has(w)) ? null : PAYBACK_RULES_GENERIC;
}

/** `mapping_rules`, read strictly: nothing stored is none; anything but a list is unreadable (null) and never rewritten. */
function parseMappingRules(raw: string | null): MappingRule[] | null {
  if (raw === null || raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MappingRule[]) : null;
  } catch {
    return null;
  }
}

/** A payback rule for the same words and account, whatever day it was made. */
const samePaybackRule = (a: MappingRule, rule: MappingRule): boolean =>
  sameMappingRule({ ...a, since: rule.since }, rule);

/** The list with the new rule FIRST (first match wins, so nothing earlier can shadow it). */
const withRuleFirst = (list: MappingRule[], rule: MappingRule): MappingRule[] => [rule, ...list.filter((r) => !samePaybackRule(r, rule))];

/** Whether the list, as it would stand, makes a deposit with these bank words a payback. */
function listMakesPayback(list: MappingRule[], rule: MappingRule, description: string): boolean {
  const mapped = mapTransactionWithSource(bankWords(description), 1, list, 'CASH', rule.accountId, rule.since);
  return mapped.type === 'CREDIT' && mapped.subtype === REIMBURSEMENT_SUBTYPE;
}

/** One stored money-in row of the account, as the breadth check reads it. */
export interface PaybackBreadthRow {
  id: string;
  /** The stored description (bank words, possibly with a sync note). */
  description: string;
  /** Signed: money in is positive. */
  amount: number;
  /** Stored type; a transfer-typed row is not a deposit "already in the ledger". */
  type?: string;
  /** Half of a linked group. */
  grouped?: boolean;
}

/**
 * Would a payback rule for `pattern` take over transfers? A refusal's words, or null.
 * Three ways, none of which depends on what typed the transfer (PB-M m-a):
 *  - the pattern itself reads as a bank transfer (`BANK_TRANSFER_KEYWORDS`);
 *  - an existing TRANSFER_* contains-rule's pattern contains it, so the new rule would
 *    catch every description that rule does (no ledger row needed);
 *  - a ledger row typed TRANSFER_*, or decided by a TRANSFER_* rule today, that it would read.
 */
export function paybackTransferRefusal(i: {
  pattern: string; accountId: string; since: string; list: MappingRule[]; rows: PaybackBreadthRow[];
}): string | null {
  if (BANK_TRANSFER_KEYWORDS.test(i.pattern)) return PAYBACK_RULES_TRANSFER_WORDS(i.pattern);
  const lower = i.pattern.toLowerCase();
  const containing = i.list.find((x) => x.activityType.startsWith('TRANSFER_') && x.matchType === 'contains' && x.pattern.toLowerCase().includes(lower));
  if (containing) return paybackRulesTakesOver(containing.pattern);
  const rule = paybackMappingRule(i.pattern, i.accountId, i.since);
  for (const r of i.rows) {
    if (!(r.amount > 0)) continue;
    const words = bankWords(r.description);
    if (!ruleApplies(rule, words, r.amount, i.accountId, i.since)) continue;
    const was = i.list.find((x) => ruleApplies(x, words, r.amount, i.accountId, i.since));
    if (was && was.activityType.startsWith('TRANSFER_')) return paybackRulesTakesOver(was.pattern);
    if ((r.type ?? '').startsWith('TRANSFER_')) return PAYBACK_RULES_TRANSFER_ROWS(i.pattern);
  }
  return null;
}

export type PaybackBreadth = { ok: true; filed: number; waiting: number } | { ok: false; message: string };

/**
 * The preview's breadth check (W10), over the account's last 90 days from the
 * ledger: the money-in rows whose bank words the new rule would DECIDE,
 * evaluated over the whole fresh mapping list with the rule in its position
 * (first) — split into those that already have a category and those waiting
 * for one (`waitingIds`). The deposit it is made from is not counted. Refuses a
 * generic pattern, and a list that would still type the source row another way.
 */
export function paybackBreadth(i: {
  pattern: string;
  accountId: string;
  /** The bank day the rule would be made. */
  since: string;
  source: { id: string; description: string };
  list: MappingRule[];
  rows: PaybackBreadthRow[];
  waitingIds: ReadonlySet<string>;
}): PaybackBreadth {
  const generic = paybackPatternRefusal(i.pattern);
  if (generic) return { ok: false, message: generic };
  const rule = paybackMappingRule(i.pattern, i.accountId, i.since);
  const list = withRuleFirst(i.list, rule);
  if (!listMakesPayback(list, rule, i.source.description)) return { ok: false, message: PAYBACK_RULES_SHADOWED };
  // A transfer this rule would take over (first match wins) would stop pairing.
  const transfer = paybackTransferRefusal({ pattern: i.pattern, accountId: i.accountId, since: i.since, list: i.list, rows: i.rows.filter((r) => r.id !== i.source.id) });
  if (transfer) return { ok: false, message: transfer };
  let filed = 0;
  let waiting = 0;
  for (const r of i.rows) {
    if (r.id === i.source.id || !(r.amount > 0)) continue;
    if (r.grouped) continue;
    // The first rule that reads the row decides it; ours must be that one.
    const decider = list.find((x) => ruleApplies(x, bankWords(r.description), r.amount, i.accountId, i.since));
    if (!decider || !sameMappingRule(decider, rule)) continue;
    if (i.waitingIds.has(r.id)) waiting += 1;
    else filed += 1;
  }
  return { ok: true, filed, waiting };
}

/**
 * Make every <pattern> deposit into one account a payback under a category
 * (W10): an add-on transaction rule — money in only, this account only, from
 * today on (`since`: a deposit already stored is never re-typed), a CREDIT
 * marked REIMBURSEMENT — which the sync applies on import, then Wealthfolio's
 * categorization rule for the category, which files only CREDITs (the
 * paybacks) in this account. The transaction rule goes FIRST in the list
 * (first match wins, so an older rule cannot shadow it), written to a list
 * re-read right before; a pattern of only generic bank words is refused. A
 * Wealthfolio rule for the same words, account and CREDIT under ANOTHER
 * category is a conflict; one under this category is reused. A write that
 * throws but landed counts as done. If Wealthfolio then refuses the category
 * rule, the transaction rule comes back out, so neither is half made — and when
 * that write fails too, it is logged so Undo can take it out. Both rules are
 * change-logged.
 */
export async function makePaybackRules(input: PaybackRulesInput, io: PaybackRulesIo, now: Date = new Date()): Promise<PaybackRulesOutcome> {
  const no = (message: string): PaybackRulesOutcome => ({ ok: false, message });
  // A gate that cannot read the add-on's version REJECTS: that is "couldn't
  // reach", logged, never "update the add-on" (PB-B, M7).
  let gate: string | null;
  try {
    gate = await io.gate();
  } catch (err) {
    io.log(`Payback rules for "${input.pattern}": could not read the installed add-on version: ${errorText(err)}`);
    return no(PAYBACK_UNREACHABLE);
  }
  if (gate) return no(gate);
  const generic = paybackPatternRefusal(input.pattern);
  if (generic) return no(generic);
  const rule = paybackMappingRule(input.pattern, input.account.id, paybackRuleSince(now));

  const matches = (r: { pattern: string; accountId?: string; activityType?: string }) =>
    r.pattern.toLowerCase() === input.pattern.toLowerCase() && r.accountId === input.account.id && r.activityType === 'CREDIT';
  // A broader rule (its words inside ours) for this account or every account, at our priority
  // or higher, for CREDITs, under ANOTHER category: Wealthfolio can pick it over ours, so the
  // reply "…is a payback under X from now on" would over-promise (M3).
  const wouldBeat = (r: Awaited<ReturnType<PaybackRulesIo['categoryRules']>>[number]): boolean =>
    r.categoryId !== null && r.categoryId !== input.categoryId
    && (r.matchType === undefined || r.matchType === 'contains')
    && (r.taxonomyId === undefined || r.taxonomyId === SPENDING_TAXONOMY_ID)
    && !r.amountOp
    && (r.accountId === undefined || r.accountId === input.account.id)
    && (r.activityType === undefined || r.activityType === 'CREDIT')
    && (r.priority ?? 0) >= PAYBACK_RULE_PRIORITY
    && r.pattern.trim() !== '' && input.pattern.toLowerCase().includes(r.pattern.trim().toLowerCase());
  let list: MappingRule[] | null;
  let haveCategoryRule: boolean;
  try {
    list = parseMappingRules(await io.secrets.get(MAPPING_RULES_SECRET_KEY));
    const all = await io.categoryRules();
    const theirs = all.filter(matches);
    const other = theirs.find((r) => r.categoryId !== input.categoryId) ?? all.find(wouldBeat);
    if (other) {
      const name = input.categories?.find((c) => c.id === other.categoryId)?.name ?? null;
      return no(paybackRulesConflict(other.pattern, input.account.name, name));
    }
    haveCategoryRule = theirs.length > 0;
  } catch (err) {
    io.log(`Payback rules for "${input.pattern}": ${errorText(err)}`);
    return no(PAYBACK_UNREACHABLE);
  }
  if (list === null) return no(UNDO_MAPPING_RULES_UNREADABLE);
  // The transfer-takeover checks, re-run here (M2): the preview may have been skipped or
  // failed, and the ledger may have changed since. A ledger that cannot be read refuses.
  let rows: PaybackBreadthRow[] = [];
  if (io.breadthRows) {
    try {
      rows = await io.breadthRows(input.account.id);
    } catch (err) {
      io.log(`Payback rules for "${input.pattern}": the account's recent deposits could not be read: ${errorText(err)}`);
      return no(PAYBACK_UNREACHABLE);
    }
  }
  const takesOver = paybackTransferRefusal({ pattern: input.pattern, accountId: input.account.id, since: rule.since!, list, rows: rows.filter((r) => r.id !== input.sourceId) });
  if (takesOver) return no(takesOver);
  const older = list.find((r) => samePaybackRule(r, rule)) ?? null;
  // An older rule for the same words that another rule sits in front of is never
  // moved (undoing the move would delete the person's own rule): it is named.
  if (older && !listMakesPayback(list, older, input.description)) {
    const front = list.find((r) => !samePaybackRule(r, rule)
      && ruleApplies(r, bankWords(input.description), 1, input.account.id, older.since));
    return no(paybackRulesBehind(front?.pattern ?? null));
  }
  const haveMapping = older !== null;
  if (haveMapping && haveCategoryRule) return no(PAYBACK_RULES_EXIST);
  // The list as it will stand must make the source deposit a payback.
  if (!listMakesPayback(withRuleFirst(list, rule), rule, input.description)) return no(PAYBACK_RULES_SHADOWED);

  /** Whether the entry was written: the reply promises an Undo only then. */
  const log = async (draft: ChangeDraft): Promise<boolean> => {
    try {
      await io.record(draft);
      return true;
    } catch (err) {
      io.log(`Payback rules for "${input.pattern}": the change log was not written: ${errorText(err)}`);
      return false;
    }
  };
  const mappingEntry = () => mappingRuleCreatedChange({
    rule, description: input.description, account: { wfId: input.account.id, name: input.account.name }, index: 0,
  });
  const readList = async (): Promise<MappingRule[] | null> => parseMappingRules(await io.secrets.get(MAPPING_RULES_SECRET_KEY));

  // 1. The transaction rule, FIRST in the list as it is right now.
  let added = false;
  if (!haveMapping) {
    try {
      const fresh = await readList();
      if (fresh === null) return no(UNDO_MAPPING_RULES_UNREADABLE);
      if (!(fresh.length > 0 && sameMappingRule(fresh[0], rule))) {
        try {
          await io.secrets.set(MAPPING_RULES_SECRET_KEY, JSON.stringify(withRuleFirst(fresh, rule)));
          added = true;
        } catch (err) {
          // A write that failed but landed counts as done (PB-B M2 style); when the
          // re-read fails too, nobody can say (m5).
          let now2: MappingRule[] | null;
          try {
            now2 = await readList();
          } catch (again) {
            io.log(`Payback rules for "${input.pattern}": the transaction rule write failed (${errorText(err)}) and so did the re-read: ${errorText(again)}`);
            return no(PAYBACK_RULES_UNSURE);
          }
          if (now2 === null) return no(PAYBACK_RULES_UNSURE);
          if (!now2.some((r) => sameMappingRule(r, rule))) throw err;
          io.log(`Payback rules for "${input.pattern}": the transaction rule write reported ${errorText(err)}, but it landed`);
          added = true;
        }
      }
    } catch (err) {
      io.log(`Payback rules for "${input.pattern}": the transaction rule was not saved: ${errorText(err)}`);
      return no(PAYBACK_RULES_SAVE_FAILED);
    }
  }

  // 2. Wealthfolio's category rule: paybacks (CREDIT) in this account only.
  const name = `${PAYBACK_RULE_NAME_PREFIX}${input.pattern}`.slice(0, RULE_NAME_MAX);
  let ruleId: string | null = null;
  let madeCategoryRule = false;
  if (!haveCategoryRule) {
    try {
      ruleId = await io.createCategoryRule({ name, pattern: input.pattern, categoryId: input.categoryId, accountId: input.account.id, activityType: 'CREDIT' });
      madeCategoryRule = true;
    } catch (err) {
      io.log(`Payback rules for "${input.pattern}": Wealthfolio refused the category rule: ${errorText(err)}`);
      // A rule that landed despite the error counts as made (PB-B M2 style).
      const landed = (await io.categoryRules().catch(() => []))
        .find((r) => matches(r) && r.categoryId === input.categoryId);
      if (landed) {
        ruleId = landed.id;
        madeCategoryRule = true;
      } else {
        if (!added) return no(PAYBACK_RULES_REFUSED);
        try {
          const cur = await readList();
          if (cur === null) throw new Error('the transaction rules are unreadable');
          await io.secrets.set(MAPPING_RULES_SECRET_KEY, JSON.stringify(cur.filter((r) => !sameMappingRule(r, rule))));
        } catch (again) {
          io.log(`Payback rules for "${input.pattern}": taking the transaction rule back failed: ${errorText(again)}`);
          await log(mappingEntry());
          return no(paybackRulesStuck(input.pattern));
        }
        return no(PAYBACK_RULES_REFUSED);
      }
    }
  }

  // 3. The change log, which never costs the rules. "Undo either rule" only when both entries were written.
  let logged = true;
  if (added) logged = (await log(mappingEntry())) && logged;
  if (madeCategoryRule) {
    logged = (await log(categoryRuleCreatedChange({
      ruleId, name, pattern: input.pattern, categoryId: input.categoryId, categoryName: input.categoryName,
      account: { wfId: input.account.id, name: input.account.name }, activityType: 'CREDIT',
    }))) && logged;
  }
  return { ok: true, message: paybackRulesDone(input.pattern, input.account.name, input.categoryName, logged) };
}
