/**
 * shared/change-undo-run.ts
 *
 * Runs an Undo or a Redo on a host: re-reads what is there now, asks the pure
 * planner (shared/change-undo.ts), performs the plan, and records the result
 * as an entry with `reverses` in the undoer's own bucket. Both hosts call it —
 * the companion behind `/changes`, the add-on behind the Change log card —
 * with their own `UndoIo`; only the companion supplies categories and rules,
 * which the add-on SDK cannot reach.
 *
 * Safety, in order (spec B2):
 *  1. Nothing is written until the state check passes. A failed read is
 *     "Couldn't reach Wealthfolio — nothing undone."
 *  2. Overrides are written first, in ONE edit of the document; a corrupt
 *     document refuses the edit and nothing else is written.
 *  3. A reversal that fails afterwards leaves its override (harmless) and says
 *     what failed. A re-created duplicate Wealthfolio refuses as an exact copy
 *     takes its override back out, so nothing changes.
 *  4. Only a reversal that worked is recorded.
 *
 * A payback's Undo and Redo (1.62, W7) say plainly what stands when a write
 * fails, never in Wealthfolio's words: a re-type Wealthfolio refused puts the
 * override back as it was ("nothing was changed"); a category step that failed
 * after the re-type is recorded, and named.
 */
import { reversalChange, type ChangeDraft, type ChangeEntry } from './change-entries.js';
import { BUDGET_TAXONOMY, DEFAULT_PERIOD_KEY, type BudgetTarget } from './budget-suggest.js';
import type { ChangeLogItem } from './change-log.js';
import {
  addonGateCovers, currentRowId, currentRuleId, latestReversal, planChangeUndo, undoAvailability, UNDO_EXACT_COPY, UNDO_NOT_POSSIBLE,
  UNDO_UNREACHABLE, UNDO_UPDATE_ADDON, type UndoOp, type UndoPlan, type UndoRow, type UndoState, type UndoStep, type UndoVariant,
} from './change-undo.js';
import {
  editSkippedTransactions, parseSkippedTransactionsStrict, REMOVED_FOR_GOOD_NOTE, SKIPPED_TRANSACTIONS_SECRET_KEY, SkippedTransactionsUnreadableError,
  withoutSkipped, withSkipped,
} from './skipped-transactions.js';
import type { SecretGet, SecretSet } from './subscription-prefs.js';
import {
  flowExternalOf, IN_TRANSIT_COMMENT_PREFIX, isInternalMarkerComment, isTransferType, rowIdByComment, txIdFromComment,
} from './sync-core.js';
import type { HostActivity, SyncHost } from './sync-host.js';
import {
  clearAccountOverride, clearTxOverride, editSyncOverrides, isUnreadableOverridesError, setAccountOverride, setTxOverride,
  hasTxOverride, type SyncOverrides,
} from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import type { MappingRule } from './types.js';
import {
  PAYBACK_REDO_STUCK, PAYBACK_REDO_UNCHANGED, PAYBACK_UNDO_STUCK, PAYBACK_UNDO_UNCHANGED, PAYBACK_UPDATE_ADDON, paybackRedoHalf, paybackUndoHalf,
} from './payback-copy.js';
import type { PaybackRow } from './payback-row.js';
import { addonUnderstandsPaybacks, addonUnderstandsVenmoNotes, INSTALLED_ADDON_VERSION_SECRET_KEY } from './version.js';

export const MAPPING_RULES_SECRET_KEY = 'mapping_rules';
export const LINKED_GROUPS_SECRET_KEY = 'linked_groups';
export const ACCOUNT_MAPPING_SECRET_KEY = 'account_mapping';
/** The note a skip-list entry written by Undo carries. */
export const UNDO_SKIP_NOTE = 'Undone in the change log';

export const UNDO_RULE_FILED_UNREADABLE = "Couldn't read which charges the rule filed — nothing was undone.";
export const UNDO_MAPPING_RULES_UNREADABLE = "Your transaction rules can't be read — nothing was changed.";

/** What a host lends the runner. */
export interface UndoIo {
  host: SyncHost;
  secrets: { get: SecretGet; set: SecretSet };
  /** The companion only: every taxonomy's assignment, and the two writes. */
  categories?: {
    assignments(activityId: string): Promise<Array<{ taxonomyId: string; categoryId: string }>>;
    assign(activityId: string, taxonomyId: string, categoryId: string): Promise<void>;
    unassign(activityId: string, taxonomyId: string): Promise<void>;
  };
  /** The companion only: Wealthfolio's categorization rules. */
  rules?: {
    list(): Promise<Array<{ id: string; name: string; pattern: string }>>;
    create(rule: { name: string; pattern: string; categoryId: string; accountId?: string }): Promise<string | null>;
    remove(id: string): Promise<void>;
    /** The charges the rule filed (assignment source "rule", its category, a note
     *  containing its words), by activity id. Null when that cannot be read. */
    filedBy(rule: { categoryId: string; pattern: string }): Promise<string[] | null>;
  };
  /** The companion only: Wealthfolio's budget targets (`/spending/budget`, project 4). */
  budgets?: {
    /** Every target now; rejects when they cannot be read. */
    targets(): Promise<BudgetTarget[]>;
    /** Sets a category's default monthly budget; resolves the target's id, or null
     *  when it was written but Wealthfolio's reply named no target. */
    set(categoryId: string, amountCents: number): Promise<string | null>;
    remove(targetId: string): Promise<void>;
  };
  /** The companion only: a payback's row by exact id, its stored instant
   *  included (1.62); null when gone. Rejects when unreachable. */
  paybacks?: {
    read(activityId: string): Promise<PaybackRow | null>;
  };
  /** Appends the reversal entry to this writer's bucket. Never rejects. */
  record(draft: ChangeDraft): Promise<void>;
  where: { host: 'addon' | 'companion'; companionVersion: string | null };
}

export type UndoOutcome =
  | { ok: true; message: string; needsSync: boolean }
  | { ok: false; message: string };

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const cents = (v: unknown) => Math.round(Math.abs(Number(v ?? 0)) * 100);
const isDuplicateRefusal = (msg: string) => /duplicate|already exists/i.test(msg);

class Refusal extends Error {}

/** A step failed after earlier ones had already taken effect. */
class PartialFailure extends Error {
  constructor(cause: unknown, readonly done: string[], readonly created: string | null = null) {
    super(message(cause));
  }
}

const STEP_WORDS: Record<string, string> = {
  skip: 'put it on the skip list', unskip: 'took it off the skip list', delete: 'removed the row', create: 're-created the row',
  import: 'wrote the row back', update: 'updated the row', assign: 'filed the category', unassign: 'took the category off',
  'delete-rule': 'deleted the rule', 'create-rule': 'created the rule', 'mapping-remove': 'removed the transaction rule',
  'mapping-add': 'added the transaction rule', 'delete-budget': 'deleted the budget', 'set-budget': 'set the budget',
};

/** Entries whose undo/redo is running right now in this process (a double tap). */
const inFlight = new Set<string>();
export const UNDO_ALREADY_RUNNING = 'That undo is already running.';
export const UNDO_SAVE_FAILED = "Couldn't save the undo — nothing was changed.";

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** mapping_rules, read strictly: a list this cannot read is never rewritten. */
async function readMappingRules(get: SecretGet): Promise<MappingRule[]> {
  const raw = await get(MAPPING_RULES_SECRET_KEY);
  if (raw === null || raw.trim() === '') return [];
  const parsed = parseJson<unknown>(raw);
  if (!Array.isArray(parsed)) throw new Refusal(UNDO_MAPPING_RULES_UNREADABLE);
  return parsed as MappingRule[];
}

const sameRule = (a: MappingRule, b: MappingRule) =>
  a.pattern === b.pattern && a.matchType === b.matchType && a.activityType === b.activityType && (a.subtype ?? '') === (b.subtype ?? '');

/**
 * On a host that cannot read groups: could this row be half of a pair someone
 * else linked? Any transfer-typed row could, except the ones the sync wrote as
 * unpaired — a held in-transit placeholder, an opening balance or a balance
 * adjustment — and a row whose `flow.is_external` is `true` (the sync's own
 * unpaired rows; Wealthfolio never links one). A row whose metadata is unknown
 * may be linked. The note alone is not trusted when the row says a link wrote
 * it (`is_external: false`): a placeholder whose promotion was refused can be
 * linked with its placeholder note still on it.
 */
export function maybeLinkedTransfer(a: HostActivity): boolean {
  if (!isTransferType(a.activityType)) return false;
  const note = a.comment ?? '';
  const external = flowExternalOf(a.metadata);
  if ((note.startsWith(IN_TRANSIT_COMMENT_PREFIX) || isInternalMarkerComment(note)) && external !== false) return false;
  return external !== true;
}

/** The row as the planner sees it, with "is it one half of a linked transfer". */
async function toUndoRow(io: UndoIo, a: HostActivity, txKey: string | null): Promise<UndoRow> {
  let linked: UndoRow['linked'];
  if (io.host.capabilities.readsSourceGroupId) {
    linked = a.sourceGroupId ? 'confirmed' : false;
  } else {
    // The add-on cannot read groups back. The ledger the sync keeps confirms
    // the links IT made; the companion's links are in no ledger, so any other
    // transfer-typed row may be half of one (deleting it would delete both).
    const ledger = parseJson<Record<string, string>>(await io.secrets.get(LINKED_GROUPS_SECRET_KEY)) ?? {};
    const txId = txIdFromComment(a.comment);
    const confirmed = (!!txKey && ledger[txKey] !== undefined) || (!!txId && ledger[txId] !== undefined);
    linked = confirmed ? 'confirmed' : maybeLinkedTransfer(a) ? 'maybe' : false;
  }
  return {
    id: a.id, accountId: a.accountId, type: a.activityType, date: a.date.slice(0, 10),
    absCents: cents(a.amount), comment: a.comment ?? '', linked,
  };
}

/** The entry's row as it stands now, or null. */
async function findRow(io: UndoIo, entry: ChangeEntry, latest: ChangeEntry | null, key: string | null): Promise<UndoRow | null> {
  const after = rec(entry.after);
  const wf = entry.account?.wfId ?? str(after.accountId)
    ?? (entry.kind === 'transaction-removed' ? str(rec(rec(entry.before).activity).accountId) : null);
  if (!wf) return null;
  const id = currentRowId(entry, latest);
  const baseline = entry.kind === 'starting-balance' || entry.kind === 'starting-balance-moved';
  const rows = [
    ...(baseline ? await io.host.listOldestActivities(wf, 50) : []),
    ...await io.host.listActivities(wf),
  ];
  let hit = id ? rows.find((r) => r.id === id) : undefined;
  if (!hit && !latest && !id && (entry.kind === 'starting-balance' || entry.kind === 'balance-correction')) {
    // R1 could not always read a new row's id back; its note (and amount) find it.
    hit = rows.find((r) => r.comment === str(after.comment) && cents(r.amount) === Math.abs(Number(after.amountCents ?? 0)));
  }
  if (!hit && entry.kind === 'import' && key && entry.account?.sfinId) {
    // Re-imported after a Redo: a new row id, the same bank transaction.
    const txId = key.slice(entry.account.sfinId.length + 1);
    hit = rows.find((r) => txIdFromComment(r.comment) === txId);
  }
  return hit ? toUndoRow(io, hit, key) : null;
}

/** An Amazon filing whose mapping read failed has no tx key: the row's note and
 *  the account mapping give it back. */
async function deriveTxKey(io: UndoIo, entry: ChangeEntry): Promise<string | null> {
  const wf = entry.account?.wfId;
  const id = entry.subject.activityIds?.[0];
  if (!wf || !id) return null;
  const row = (await io.host.listActivities(wf)).find((r) => r.id === id);
  const txId = txIdFromComment(row?.comment);
  const mapping = parseJson<Record<string, string>>(await io.secrets.get(ACCOUNT_MAPPING_SECRET_KEY)) ?? {};
  const sfin = Object.entries(mapping).find(([, w]) => w === wf)?.[0];
  return txId && sfin ? accountTxKey(sfin, txId) : null;
}

async function gather(io: UndoIo, entry: ChangeEntry, op: UndoOp, latest: ChangeEntry | null, variant: UndoVariant): Promise<UndoState> {
  const after = rec(entry.after);
  const key = entry.subject.txKeys?.[0] ?? null;
  const state: UndoState = {};
  const wf = entry.account?.wfId ?? str(after.accountId);
  const needsCurrency = ['balance-correction', 'starting-balance', 'starting-balance-moved', 'amazon-label', 'venmo-note'].includes(entry.kind);
  if (needsCurrency && wf) {
    state.currency = (await io.host.listAccounts()).find((a) => a.id === wf)?.currency ?? 'USD';
  }
  switch (entry.kind) {
    case 'category-filed':
    case 'opening-balance-filed': {
      const id = entry.subject.activityIds?.[0];
      if (!io.categories || !id) throw new Refusal(UNDO_NOT_POSSIBLE);
      state.assignments = await io.categories.assignments(id);
      if (entry.kind === 'category-filed' && entry.actor === 'auto' && !key) state.txKey = await deriveTxKey(io, entry);
      return state;
    }
    case 'category-rule-created': {
      if (!io.rules) throw new Refusal(UNDO_NOT_POSSIBLE);
      const rules = await io.rules.list();
      const id = currentRuleId(entry, latest);
      const byId = id ? rules.find((r) => r.id === id) : undefined;
      const byName = rules.find((r) => r.name === str(after.name) && r.pattern === str(after.pattern));
      // Undo deletes the rule by its id; by name only when the log has no id
      // (the create reply carried none). Redo only asks whether it is back.
      state.rule = (op === 'undo' ? (id ? byId : byName) : (byId ?? byName)) ?? null;
      if (op === 'undo' && variant === 'unfile') {
        const filed = await io.rules.filedBy({ categoryId: String(after.categoryId ?? ''), pattern: String(after.pattern ?? '') });
        if (filed === null) throw new Refusal(UNDO_RULE_FILED_UNREADABLE);
        state.ruleFiled = filed;
      }
      return state;
    }
    case 'mapping-rule-created':
      state.mappingRules = await readMappingRules(io.secrets.get);
      return state;
    case 'budget-set':
      if (!io.budgets) throw new Refusal(UNDO_NOT_POSSIBLE);
      state.budgetTargets = await io.budgets.targets();
      return state;
    case 'starting-balance':
      state.row = await findRow(io, entry, latest, key);
      if (op === 'redo' && wf) {
        state.startingBalanceId = (await io.host.listOldestActivities(wf, 50)).find((r) => r.comment === str(after.comment))?.id ?? null;
      }
      return state;
    case 'balance-correction':
    case 'starting-balance-moved':
    case 'duplicate-removed':
    case 'amazon-label':
    case 'venmo-note':
      state.row = await findRow(io, entry, latest, key);
      return state;
    case 'transaction-removed':
      // Only a Redo acts on a row: the one the last Undo put back.
      if (op === 'redo') state.row = await findRow(io, entry, latest, key);
      return state;
    case 'payback-filed': {
      // Re-read by exact id, with its stored instant: the re-type writes it back unchanged.
      const id = currentRowId(entry, latest);
      if (!io.paybacks || !io.categories || !id) throw new Refusal(UNDO_NOT_POSSIBLE);
      state.payback = await io.paybacks.read(id);
      state.assignments = state.payback ? await io.categories.assignments(id) : [];
      return state;
    }
    case 'import': {
      state.row = await findRow(io, entry, latest, key);
      // A pending row that later posted carries a NEW tx id in its note: the skip
      // list needs the key the sync will actually see. A redo takes off the key
      // the undo put on.
      const sfin = entry.account?.sfinId;
      const nowTxId = txIdFromComment(state.row?.comment);
      const lastKey = op === 'redo' ? str(rec(latest?.after).txKey) : null;
      if (lastKey) state.txKey = lastKey;
      else if (op === 'undo' && sfin && nowTxId) state.txKey = accountTxKey(sfin, nowTxId);
      return state;
    }
    default:
      return state;
  }
}

const isOverrideStep = (s: UndoStep) => s.do === 'set-tx' || s.do === 'clear-tx' || s.do === 'set-account' || s.do === 'clear-account';

function applyOverride(o: SyncOverrides, s: UndoStep, now: Date, entryId: string): SyncOverrides {
  switch (s.do) {
    case 'set-tx': return setTxOverride(o, s.txKey, s.flag, now, { entryId, label: s.label });
    case 'clear-tx': return clearTxOverride(o, s.txKey, s.flag);
    case 'set-account': return setAccountOverride(o, s.sfinId, s.flag, now, { label: s.label });
    case 'clear-account': return clearAccountOverride(o, s.sfinId, s.flag);
    default: return o;
  }
}

/** Undoes what `applyOverride` set (only `set-*` steps are ever rolled back). */
function rollbackOverride(o: SyncOverrides, s: UndoStep): SyncOverrides {
  if (s.do === 'set-tx') return clearTxOverride(o, s.txKey, s.flag);
  if (s.do === 'set-account') return clearAccountOverride(o, s.sfinId, s.flag);
  return o;
}

/** Performs the reversal steps; resolves the id of a row a step created. */
async function perform(io: UndoIo, steps: UndoStep[], now: Date, skipNote: string = UNDO_SKIP_NOTE): Promise<string | null> {
  let created: string | null = null;
  const done: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    try {
      if (s.do === 'skip' || s.do === 'unskip') {
        // Every consecutive key in ONE edit of the list.
        const group: Array<{ account: string; txId: string }> = [];
        while (i < steps.length) {
          const n = steps[i];
          if (n.do !== s.do) break;
          group.push({ account: n.account, txId: n.txId });
          i++;
        }
        i--;
        await editSkippedTransactions(io.secrets.get, io.secrets.set, (l) => group.reduce(
          (acc, g) => (s.do === 'skip'
            ? withSkipped(acc, { account: g.account, txId: g.txId, note: skipNote, at: now.toISOString() })
            : withoutSkipped(acc, g.account, g.txId)),
          l,
        ));
      } else {
        created = await performStep(io, s, created);
      }
    } catch (err) {
      if (err instanceof Refusal || done.length === 0) throw err;
      throw new PartialFailure(err, done, created);
    }
    done.push(STEP_WORDS[s.do] ?? s.do);
  }
  return created;
}

/** One step that is not a skip-list edit (`perform` batches those itself). */
async function performStep(io: UndoIo, s: UndoStep, prior: string | null): Promise<string | null> {
  let created = prior;
  {
    switch (s.do) {
      case 'delete': {
        const res = await io.host.saveMany({ deleteIds: [s.activityId] });
        if (res.errors.length) throw new Error(res.errors.map((e) => e.message).join('; '));
        break;
      }
      case 'create': {
        const res = await io.host.saveMany({ creates: [s.write] });
        const errs = res.errors.map((e) => e.message).join('; ');
        if (errs && isDuplicateRefusal(errs)) throw new Refusal(UNDO_EXACT_COPY);
        if (errs || !res.created[0]) throw new Error(errs || 'Wealthfolio stored nothing');
        created = res.created[0].id;
        break;
      }
      case 'import': {
        await io.host.importActivities([s.row]);
        const read = async () => [
          ...await io.host.listOldestActivities(s.row.accountId, 50),
          ...await io.host.listActivities(s.row.accountId),
        ];
        created = (await rowIdByComment(read, s.row.comment, { amount: s.row.amount, fee: s.row.fee ?? 0 })) ?? null;
        break;
      }
      case 'update': {
        const res = await io.host.saveMany({ updates: [s.write] });
        if (res.errors.length) throw new Error(res.errors.map((e) => e.message).join('; '));
        break;
      }
      case 'assign':
        await io.categories!.assign(s.activityId, s.taxonomyId, s.categoryId);
        break;
      case 'unassign':
        await io.categories!.unassign(s.activityId, s.taxonomyId);
        break;
      case 'delete-rule':
        await io.rules!.remove(s.ruleId);
        break;
      case 'create-rule':
        created = (await io.rules!.create(s.rule)) ?? null;
        break;
      case 'mapping-remove': {
        const rule = s.rule;
        const list = await readMappingRules(io.secrets.get);
        await io.secrets.set(MAPPING_RULES_SECRET_KEY, JSON.stringify(list.filter((r) => !sameRule(r, rule))));
        break;
      }
      case 'mapping-add': {
        const list = await readMappingRules(io.secrets.get);
        if (!list.some((r) => sameRule(r, s.rule))) await io.secrets.set(MAPPING_RULES_SECRET_KEY, JSON.stringify([...list, s.rule]));
        break;
      }
      case 'delete-budget':
        await io.budgets!.remove(s.targetId);
        break;
      case 'set-budget':
        created = await io.budgets!.set(s.categoryId, s.amountCents);
        break;
      default:
        break;
    }
  }
  return created;
}

/** The `after` fields a reversal entry carries for the next undo or redo. */
function reversalExtra(p: UndoPlan, created: string | null, state: UndoState): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (p.rowAfter !== undefined) {
    const id = p.rowAfter === 'created' ? created : p.rowAfter;
    // Always explicit (undefined when none), so a later redo/undo never reads a stale id.
    extra.activityId = id ?? undefined;
  }
  if (p.ruleAfter !== undefined) extra.ruleId = p.ruleAfter === 'created' ? created : null;
  if (p.budgetAfter !== undefined) extra.targetId = p.budgetAfter === 'created' ? created : null;
  if (state.txKey && p.steps.some((s) => s.do === 'skip')) extra.txKey = state.txKey;
  if (state.ruleFiled && p.steps.some((s) => s.do === 'unassign')) extra.unfiledActivityIds = [...state.ruleFiled];
  return extra;
}

/**
 * Undo or redo one entry. `entries` is the log as just read (newest first):
 * it says whether the entry is undone and what an earlier reversal left.
 */
export async function runChangeUndo(
  entry: ChangeLogItem,
  entries: readonly ChangeEntry[],
  op: UndoOp,
  io: UndoIo,
  variant: UndoVariant = 'plain',
  now: Date = new Date(),
): Promise<UndoOutcome> {
  if (inFlight.has(entry.id)) return { ok: false, message: UNDO_ALREADY_RUNNING };
  inFlight.add(entry.id);
  try {
    return await runOnce(entry, entries, op, io, variant, now);
  } finally {
    inFlight.delete(entry.id);
  }
}

async function runOnce(
  entry: ChangeLogItem, entries: readonly ChangeEntry[], op: UndoOp, io: UndoIo, variant: UndoVariant, now: Date,
): Promise<UndoOutcome> {
  const available = undoAvailability(entry, io.where);
  if (available.kind === 'none') return { ok: false, message: UNDO_NOT_POSSIBLE };
  if (available.kind !== 'ready') return { ok: false, message: available.text };
  // Telegram: an override an older INSTALLED add-on cannot read waits for it.
  // Unknown (no version written, or the read failed) waits too.
  if (io.where.host === 'companion' && addonGateCovers(entry)) {
    let installed: string | null = null;
    try {
      installed = await io.secrets.get(INSTALLED_ADDON_VERSION_SECRET_KEY);
    } catch {
      installed = null;
    }
    const seen = installed && installed.trim() ? installed : null;
    if (entry.kind === 'payback-filed') {
      if (!addonUnderstandsPaybacks(seen)) return { ok: false, message: PAYBACK_UPDATE_ADDON };
    } else if (!addonUnderstandsVenmoNotes(seen)) {
      return { ok: false, message: UNDO_UPDATE_ADDON };
    }
  }
  const latest = latestReversal(entries, entry.id);

  let state: UndoState;
  let preSkipped = new Set<string>();
  try {
    if (entry.kind === 'transaction-removed') {
      // Both Undo and Redo write the skip list: refuse before touching anything.
      const parsed = parseSkippedTransactionsStrict(await io.secrets.get(SKIPPED_TRANSACTIONS_SECRET_KEY));
      if (parsed.kind === 'corrupt') throw new Refusal(new SkippedTransactionsUnreadableError().message);
      if (parsed.kind === 'ok') preSkipped = new Set(parsed.list.map((s) => accountTxKey(s.account, s.txId)));
    }
    state = await gather(io, entry, op, latest, variant);
  } catch (err) {
    return { ok: false, message: err instanceof Refusal ? err.message : UNDO_UNREACHABLE };
  }
  const decision = planChangeUndo(entry, op, state, { latest, variant });
  if (!decision.ok) return { ok: false, message: decision.reason };
  const p = decision.plan;

  const overrideSteps = p.steps.filter(isOverrideStep);
  const rest = p.steps.filter((s) => !isOverrideStep(s));
  // Overrides THIS undo set (a flag already there before is not ours to take back).
  let ours: UndoStep[] = [];
  // The document as this run found it: a payback whose re-type failed puts it back.
  let prior = null as SyncOverrides | null;
  if (overrideSteps.length > 0) {
    try {
      await editSyncOverrides(io.secrets.get, io.secrets.set, (o) => {
        prior = o;
        ours = overrideSteps.filter((s) => !(s.do === 'set-tx' && hasTxOverride(o, s.txKey, s.flag)));
        return overrideSteps.reduce((d, s) => applyOverride(d, s, now, entry.id), o);
      }, now);
    } catch (err) {
      return { ok: false, message: isUnreadableOverridesError(err) ? message(err) : UNDO_SAVE_FAILED };
    }
  }

  let created: string | null;
  try {
    created = await perform(io, rest, now, entry.kind === 'transaction-removed' ? REMOVED_FOR_GOOD_NOTE : UNDO_SKIP_NOTE);
  } catch (err) {
    const setStep = rest.find((s): s is Extract<UndoStep, { do: 'set-budget' }> => s.do === 'set-budget');
    // A Redo's POST that threw may still have committed: when the category's default
    // target now holds exactly the amount, the reversal is done (as apply's recovery).
    const landed = op === 'redo' && setStep && io.budgets && !(err instanceof Refusal)
      ? await io.budgets.targets().then((ts) => ts.find((t) => t.targetType === 'category' && t.taxonomyId === BUDGET_TAXONOMY
        && t.categoryId === setStep.categoryId && t.periodKey === DEFAULT_PERIOD_KEY && t.amountCents === setStep.amountCents), () => undefined)
      : undefined;
    if (landed) {
      try {
        await io.record(reversalChange(entry, op, reversalExtra(p, landed.id, state)));
      } catch {
        // Never costs the redo: the writer records a gap instead.
      }
      return { ok: true, message: p.done, needsSync: p.needsSync };
    }
    if (entry.kind === 'payback-filed') {
      const name = str(rec(entry.after).categoryName) ?? 'its category';
      if (err instanceof PartialFailure) {
        // The row was re-typed and the category step failed: keep the log honest.
        try {
          await io.record(reversalChange(entry, op, reversalExtra(p, err.created, state)));
        } catch {
          // Never costs the reversal.
        }
        return { ok: false, message: op === 'undo' ? paybackUndoHalf(name) : paybackRedoHalf(name) };
      }
      // The re-type failed: every override this run touched goes back as it was.
      const was = prior;
      try {
        await editSyncOverrides(io.secrets.get, io.secrets.set, (o) => overrideSteps.reduce((d, s) => {
          if (s.do !== 'set-tx' && s.do !== 'clear-tx') return d;
          if (!was || !hasTxOverride(was, s.txKey, s.flag)) return clearTxOverride(d, s.txKey, s.flag);
          const e = was.tx[s.txKey];
          return setTxOverride(d, s.txKey, s.flag, new Date(e.at), {
            ...(e.entryId ? { entryId: e.entryId } : {}), ...(e.label ? { label: e.label } : {}),
          });
        }, o), now);
      } catch {
        return { ok: false, message: op === 'undo' ? PAYBACK_UNDO_STUCK : PAYBACK_REDO_STUCK };
      }
      return { ok: false, message: op === 'undo' ? PAYBACK_UNDO_UNCHANGED : PAYBACK_REDO_UNCHANGED };
    }
    if (entry.kind === 'transaction-removed' && err instanceof PartialFailure) {
      const base = `Couldn't finish the ${op}: ${message(err)}`.replace(/\.$/, '');
      if (op === 'undo' && err.created) {
        // The row is back: keep the log honest, so Redo then Undo can finish it.
        try {
          await io.record(reversalChange(entry, op, reversalExtra(p, err.created, state)));
        } catch {
          // Never costs the undo.
        }
        return {
          ok: false,
          message: `${base}. The transaction is back, but it is still on the skip list — Redo it, then Undo again, to finish.`,
        };
      }
      if (op === 'redo') {
        // The skip went through and the delete did not: take back only the keys this Redo added.
        const added = p.steps.filter((s): s is Extract<UndoStep, { do: 'skip' }> => s.do === 'skip')
          .filter((s) => !preSkipped.has(accountTxKey(s.account, s.txId)));
        // Nothing added (a half-done Undo left it skipped): nothing to write, and it stays skipped.
        if (added.length === 0) {
          return { ok: false, message: `${base}. Nothing was removed; it was already on the skip list and stays there.` };
        }
        try {
          await editSkippedTransactions(io.secrets.get, io.secrets.set, (l) => added.reduce((acc, s) => withoutSkipped(acc, s.account, s.txId), l));
          return { ok: false, message: `${base}. It is off the skip list again, so nothing changed.` };
        } catch {
          return { ok: false, message: `${base}. It stays on the skip list — the bank feed won't import it again until it's taken off.` };
        }
      }
    }
    if (err instanceof Refusal) {
      // Refused as an exact copy: take the override back out, so nothing changed.
      if (ours.length > 0) {
        try {
          await editSyncOverrides(io.secrets.get, io.secrets.set, (o) => ours.reduce(rollbackOverride, o), now);
        } catch {
          return { ok: false, message: `${err.message} The setting it saved could not be taken back out, so it stays.` };
        }
      }
      return { ok: false, message: err.message };
    }
    const what = op === 'undo' ? 'undo' : 'redo';
    const base = `Couldn't finish the ${what}: ${message(err)}`;
    return { ok: false, message: err instanceof PartialFailure ? `${base.replace(/\.$/, '')}. Part of it was already done: ${err.done.join(', ')}.` : base };
  }

  try {
    await io.record(reversalChange(entry, op, reversalExtra(p, created, state)));
  } catch {
    // Never costs the undo: the writer records a gap instead.
  }
  return { ok: true, message: p.done, needsSync: p.needsSync };
}
