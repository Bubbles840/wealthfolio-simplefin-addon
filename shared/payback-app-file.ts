/**
 * shared/payback-app-file.ts
 *
 * Filing a payback from the app (1.62.0, W11): the add-on's sibling of the
 * companion's `filePayback` (shared/payback.ts, which stays as it is). The
 * add-on SDK cannot file one row, so the category goes on through a one-off
 * rule (shared/payback-app.ts) — saved BEFORE the row is re-typed: the re-type
 * sets off Wealthfolio's own rule run in the background, and the one-off rule
 * must already be there to win it over an older rule for CREDITs (W10's
 * "Make every … deposit a payback" makes one at priority 50). While the row is
 * still a DEPOSIT the rule cannot match it (CREDIT only), so the run the rule
 * save sets off files nothing. In order:
 *
 *  1. the gate (`appPaybackGate`: Wealthfolio 3.9+, a companion of 1.62.0+);
 *  2. the row re-read by id and planned (`planPayback`), the category still
 *     listed, then Wealthfolio's facts for the row: tracked by Spending, in no
 *     transfer, filed nowhere (the SDK cannot take a filing off);
 *  3. one-off rules a failed run left behind are swept, then this row's is
 *     saved;
 *  4. the `asReimbursement` override, re-read right before it is written;
 *  5. the row re-typed (`paybackRetype`: the stored instant, a bare day at
 *     noon UTC);
 *  6. `rerunRules(true)`, uncategorized rows only, retried once after a short
 *     pause — a failure is not final: the activity write's own run is
 *     debounced, so it lands after the read-back, but may still file it;
 *  7. the filing confirmed by reading the row's facts back;
 *  8. the one-off rule deleted, filed or not;
 *  9. `payback-filed` logged with the category Wealthfolio CONFIRMED (none
 *     when it confirmed none; the CHOSEN one when the rule run succeeded but
 *     the read-back failed, so Undo can un-file it), through the change log's strict append, so a log that
 *     was not written is said ("no Undo") — Telegram's Undo un-files exactly
 *     the logged category.
 *
 * What a failure leaves is said plainly, as `filePayback` says it; only the
 * overrides this run added are ever taken back; a rule that could not be
 * deleted is named. Wealthfolio's own error text goes to the log, never to the
 * message. Pure: src/utils/app-payback.ts lends the add-on's calls.
 */
import { SPENDING_TAXONOMY_ID } from './cash-flow-bucket.js';
import { SYNC_BOOKKEEPING_CATEGORY } from './bookkeeping-filing.js';
import { paybackFiledChange, type ChangeDraft } from './change-entries.js';
import { planPayback, type PaybackPlan } from './payback.js';
import {
  leftoverPaybackKeys, paybackOnceRule, type ListedRule, type PaybackCategory, type PaybackOnceRule,
} from './payback-app.js';
import {
  PAYBACK_APP_OVERRIDE_UNSURE, PAYBACK_APP_SETTING_HINT, PAYBACK_CATEGORY_RESERVED, PAYBACK_APP_UNDO_HINT, PAYBACK_APP_UPDATE_STUCK, PAYBACK_APP_UPDATE_UNSURE, PAYBACK_CATEGORY_GONE, PAYBACK_CHANGED,
  PAYBACK_GONE, PAYBACK_GONE_STUCK, PAYBACK_LINKED, PAYBACK_MAPPING_UNREADABLE, PAYBACK_NO_UNDO, PAYBACK_NO_UNDO_SETTING, PAYBACK_NOT_IN_SPENDING,
  PAYBACK_OVERRIDE_FAILED, PAYBACK_RULE_REFUSED, PAYBACK_RUNNING, PAYBACK_UNREACHABLE, PAYBACK_UPDATE_REFUSED,
  paybackAlreadyFiled, paybackAppUnfiled, paybackAppUnsure, paybackDone, paybackFiledFirst, paybackLeftoverRule,
} from './payback-copy.js';
import { isPaybackRow, type PaybackRow } from './payback-row.js';
import type { SecretGet, SecretSet } from './subscription-prefs.js';
import type { ActivityWrite } from './sync-host.js';
import {
  clearTxOverride, editSyncOverrides, hasTxOverride, isUnreadableOverridesError, loadSyncOverrides, setTxOverride,
  SYNC_OVERRIDES_UNREADABLE_MESSAGE,
} from './sync-overrides.js';
import { removalFingerprint, RemoveMappingUnreadableError } from './tx-remove.js';
import { OPENING_BALANCES_CATEGORY } from './sync-core.js';
import { filingOfFact, linkedOfFact, type CashFact } from './wf-facts.js';

/** What the add-on lends `filePaybackInApp`. */
export interface AppPaybackIo {
  /** Why the app may not file a payback now (`appPaybackGate`), or null. */
  gate(): Promise<string | null>;
  /** The row by exact id, now; null when gone. Rejects when unreachable. */
  read(activityId: string): Promise<PaybackRow | null>;
  /** The SimpleFin accounts that sync into this Wealthfolio account. Rejects
   *  when the mapping cannot be read (`RemoveMappingUnreadableError` when it
   *  was read and is not a mapping). */
  feeds(wfAccountId: string): Promise<string[]>;
  secrets: { get: SecretGet; set: SecretSet };
  /** Wealthfolio's facts for the row (`searchCashActivities`); null when it
   *  lists none (an account its Spending does not track). Rejects when they
   *  cannot be read. */
  fact(row: PaybackRow): Promise<CashFact | null>;
  /** Every category, all kinds (`paybackCategoriesOf`). Rejects when unreadable. */
  categories(): Promise<PaybackCategory[]>;
  /** This add-on's own categorization rules (`getRules`). Rejects when unreadable. */
  rules(): Promise<ListedRule[]>;
  /** Saves a rule by its key (an upsert). Rejects when Wealthfolio refuses it. */
  saveRule(rule: PaybackOnceRule): Promise<void>;
  /** Deletes the rule with this key; nothing when it is absent. Rejects when Wealthfolio refuses. */
  deleteRule(ruleKey: string): Promise<void>;
  /** One update through the bulk endpoint. Rejects when Wealthfolio refuses it. */
  update(write: ActivityWrite): Promise<void>;
  /** Wealthfolio's rule run over the rows with no category (`rerunRules(true)`). */
  rerunRules(): Promise<void>;
  /** The short pause before the rule run is retried; absent: one second. */
  pause?(ms: number): Promise<void>;
  /** Appends to the change log: whether THIS entry was written. */
  record(draft: ChangeDraft): Promise<boolean>;
  log(msg: string): void;
}

/** The click: the row, and the spending category chosen. */
export interface AppPaybackChoice {
  activityId: string;
  categoryId: string;
  /** `removalFingerprint` of the row as the story showed it. Absent (the
   *  needs-a-category list has no note to show): no check. */
  shown?: string;
}

/** `filed`: it is a payback, filed under a category (the message says which).
 *  `partial`: something changed, not all of it — the message says what stands.
 *  `refused`: nothing was written to the row. */
export type AppPaybackOutcome =
  | { kind: 'filed'; message: string }
  | { kind: 'partial'; message: string }
  | { kind: 'refused'; message: string };

/** Activity ids being filed right now: a second click on the same row writes nothing. */
const inFlight = new Set<string>();
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const fingerprintOf = (r: PaybackRow): string => removalFingerprint({
  activityId: r.id, note: r.notes, absCents: r.absCents, date: r.date, activityType: r.type, accountName: r.accountName,
});
const lines = (...parts: Array<string | null>): string => parts.filter((p): p is string => !!p).join('\n');

/** File one deposit as a payback from the app. Never rejects. */
export async function filePaybackInApp(choice: AppPaybackChoice, io: AppPaybackIo, now: Date): Promise<AppPaybackOutcome> {
  if (inFlight.has(choice.activityId)) return { kind: 'refused', message: PAYBACK_RUNNING };
  inFlight.add(choice.activityId);
  try {
    return await fileOnce(choice, io, now);
  } finally {
    inFlight.delete(choice.activityId);
  }
}

async function fileOnce(choice: AppPaybackChoice, io: AppPaybackIo, now: Date): Promise<AppPaybackOutcome> {
  const refused = (message: string): AppPaybackOutcome => ({ kind: 'refused', message });
  const say = (msg: string) => io.log(`Payback ${choice.activityId}: ${msg}`);

  // 1. The gate.
  let gate: string | null;
  try {
    gate = await io.gate();
  } catch (err) {
    say(`the gate could not be read: ${errorText(err)}`);
    return refused(PAYBACK_UNREACHABLE);
  }
  if (gate) return refused(gate);

  // 2. The row, re-read and planned; the category; Wealthfolio's facts.
  let row: PaybackRow | null;
  let plan: PaybackPlan;
  let categories: PaybackCategory[] = [];
  let chosen: PaybackCategory | undefined;
  let fact: CashFact | null = null;
  try {
    row = await io.read(choice.activityId);
    if (row && choice.shown !== undefined && choice.shown !== fingerprintOf(row)) return refused(PAYBACK_CHANGED);
    const feeds = row ? await io.feeds(row.accountId) : [];
    const overrides = await loadSyncOverrides(io.secrets.get);
    categories = await io.categories();
    chosen = categories.find((c) => c.id === choice.categoryId && c.kind === 'expense');
    plan = planPayback({ row, feeds, overrides, category: { id: choice.categoryId, name: chosen?.name ?? '' } });
    if (plan.ok && chosen) fact = await io.fact(row!);
  } catch (err) {
    say(errorText(err));
    return refused(err instanceof RemoveMappingUnreadableError ? PAYBACK_MAPPING_UNREADABLE : PAYBACK_UNREACHABLE);
  }
  if (!plan.ok) return refused(plan.reason);
  if (!chosen) return refused(PAYBACK_CATEGORY_GONE);
  // Defence in depth: the picker already hides the categories the sync keeps for itself.
  if (chosen.name === OPENING_BALANCES_CATEGORY || chosen.name === SYNC_BOOKKEEPING_CATEGORY) return refused(PAYBACK_CATEGORY_RESERVED);
  if (!fact) return refused(PAYBACK_NOT_IN_SPENDING);
  if (linkedOfFact(fact)) return refused(PAYBACK_LINKED);
  const nameOf = (id: string): string | null => categories.find((c) => c.id === id)?.name ?? null;
  const filing = filingOfFact(fact);
  if (filing) return refused(paybackAlreadyFiled(nameOf(filing.categoryId) ?? 'another category'));
  const r = row!;
  const w = plan.writes;
  // planPayback refused a row whose note carries no tx id.
  const once = paybackOnceRule(r, chosen.id)!;

  const dropRule = async (): Promise<boolean> => {
    try {
      await io.deleteRule(once.ruleKey);
      return true;
    } catch (err) {
      say(`the one-off rule ${once.ruleKey} could not be deleted: ${errorText(err)}`);
      return false;
    }
  };
  const left = (gone: boolean): string | null => (gone ? null : paybackLeftoverRule(once.name));
  const record = async (draft: ChangeDraft): Promise<boolean> => {
    try {
      return await io.record(draft);
    } catch (err) {
      say(`the change log was not written: ${errorText(err)}`);
      return false;
    }
  };
  // The payback setting stays on a row that may not be a payback: logged with no category, so Telegram's Undo takes it off.
  const unconfirmed = async (message: string, gone: boolean): Promise<AppPaybackOutcome> => {
    const saved = await record(paybackFiledChange({ ...w.entry, categoryId: null, categoryName: null }));
    return { kind: 'partial', message: lines(message, saved ? PAYBACK_APP_SETTING_HINT : PAYBACK_NO_UNDO_SETTING, left(gone)) };
  };

  // 3. One-off rules a failed run left behind, then this row's — before the re-type.
  try {
    for (const key of leftoverPaybackKeys(await io.rules())) {
      try {
        await io.deleteRule(key);
        say(`deleted the one-off rule ${key}, left behind by an earlier payback`);
      } catch (err) {
        say(`the one-off rule ${key}, left behind by an earlier payback, could not be deleted: ${errorText(err)}`);
      }
    }
  } catch (err) {
    say(`the add-on's rules could not be read for left-behind one-off rules: ${errorText(err)}`);
  }
  try {
    await io.saveRule(once);
  } catch (err) {
    say(`Wealthfolio refused the one-off rule: ${errorText(err)}`);
    // It may have landed before its answer was lost.
    return refused(lines(PAYBACK_RULE_REFUSED, left(await dropRule())));
  }

  // 4. The override, re-read right before it is written. Only what this run adds is ever taken back.
  let added: string[] = [];
  try {
    await editSyncOverrides(io.secrets.get, io.secrets.set, (o) => {
      added = w.txKeys.filter((k) => !hasTxOverride(o, k, 'asReimbursement'));
      return w.txKeys.reduce((d, k) => setTxOverride(d, k, 'asReimbursement', now, { label: w.label }), o);
    }, now);
  } catch (err) {
    say(`the override was not saved: ${errorText(err)}`);
    const unreadable = isUnreadableOverridesError(err);
    // The write can fail after it landed (a lost response): read it again.
    let landed = false;
    let unsure = false;
    if (!unreadable) {
      try {
        const again = await loadSyncOverrides(io.secrets.get);
        landed = !again.unreadable && w.txKeys.every((k) => hasTxOverride(again.overrides, k, 'asReimbursement'));
      } catch (readErr) {
        unsure = true;
        say(`could not read the overrides again: ${errorText(readErr)}`);
      }
    }
    if (unsure && added.length > 0) {
      // Whether it landed is unknown: take back what this run added; if that fails too, the setting may be on.
      try {
        await editSyncOverrides(io.secrets.get, io.secrets.set, (o) => added.reduce((d, k) => clearTxOverride(d, k, 'asReimbursement'), o), now);
      } catch (undoErr) {
        say(`taking the override back failed: ${errorText(undoErr)}`);
        return unconfirmed(PAYBACK_APP_OVERRIDE_UNSURE, await dropRule());
      }
    }
    if (!landed) return refused(lines(unreadable ? SYNC_OVERRIDES_UNREADABLE_MESSAGE : PAYBACK_OVERRIDE_FAILED, left(await dropRule())));
  }

  // 5. The re-type. A refused update is read again: its answer can be lost after it landed.
  try {
    await io.update(w.update);
  } catch (err) {
    say(`the update failed: ${errorText(err)}`);
    let again: PaybackRow | null;
    try {
      again = await io.read(choice.activityId);
    } catch (readErr) {
      say(`could not tell whether the update landed: ${errorText(readErr)}`);
      return unconfirmed(PAYBACK_APP_UPDATE_UNSURE, await dropRule());
    }
    if (!again || !isPaybackRow(again)) {
      const gone = await dropRule();
      try {
        if (added.length > 0) {
          await editSyncOverrides(io.secrets.get, io.secrets.set, (o) => added.reduce((d, k) => clearTxOverride(d, k, 'asReimbursement'), o), now);
        }
      } catch (undoErr) {
        say(`taking the override back failed: ${errorText(undoErr)}`);
        if (!again) return { kind: 'partial', message: lines(PAYBACK_GONE_STUCK, left(gone)) };
        return unconfirmed(PAYBACK_APP_UPDATE_STUCK, gone);
      }
      return refused(lines(again ? PAYBACK_UPDATE_REFUSED : PAYBACK_GONE, left(gone)));
    }
  }

  // 6. Wealthfolio's rule run, now, retried once after a pause; the filing is then read back either way (the activity write's own run is debounced and usually lands after this).
  let ruleRunOk = false;
  for (let attempt = 1; attempt <= 2 && !ruleRunOk; attempt += 1) {
    try {
      await io.rerunRules();
      ruleRunOk = true;
    } catch (err) {
      say(`the rule run failed${attempt === 1 ? ', trying once more' : ''}: ${errorText(err)}`);
      if (attempt === 1) await (io.pause ?? ((ms: number) => new Promise<void>((done) => { setTimeout(done, ms); })))(1000);
    }
  }

  // 7. What Wealthfolio filed it under, read back. Undefined: couldn't tell.
  let filedAs: string | null | undefined;
  try {
    const after = await io.fact(r);
    if (!after) say('Wealthfolio did not list it after the re-type');
    filedAs = after ? (after.filings.find((f) => f.taxonomyId === SPENDING_TAXONOMY_ID)?.categoryId ?? null) : undefined;
  } catch (err) {
    say(`could not read back what it is filed under: ${errorText(err)}`);
    filedAs = undefined;
  }

  // 8. The one-off rule comes out, filed or not.
  const gone = await dropRule();

  // 9. The change log: the category Wealthfolio confirmed, else none. A read-back that failed after a successful
  // rule run logs the chosen category: the rule likely filed it, and Undo needs it to un-file.
  const confirmed = filedAs === undefined ? (ruleRunOk ? chosen.id : null) : filedAs;
  const saved = await record(paybackFiledChange({ ...w.entry, categoryId: confirmed, categoryName: confirmed ? nameOf(confirmed) : null }));
  const tail = saved ? PAYBACK_APP_UNDO_HINT : PAYBACK_NO_UNDO;
  if (filedAs === chosen.id) {
    return { kind: 'filed', message: lines(paybackDone(chosen.name, chosen.parentName ?? chosen.name, r.absCents), tail, left(gone)) };
  }
  if (filedAs) return { kind: 'filed', message: lines(paybackFiledFirst(nameOf(filedAs) ?? 'another category'), tail, left(gone)) };
  return { kind: 'partial', message: lines(filedAs === null ? paybackAppUnfiled(chosen.name) : paybackAppUnsure(chosen.name), tail, left(gone)) };
}
