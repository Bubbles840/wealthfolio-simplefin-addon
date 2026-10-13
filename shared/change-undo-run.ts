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
 */
import { reversalChange, type ChangeDraft, type ChangeEntry } from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import {
  currentRowId, currentRuleId, latestReversal, planChangeUndo, undoAvailability, UNDO_EXACT_COPY, UNDO_NOT_POSSIBLE,
  UNDO_UNREACHABLE, type UndoOp, type UndoPlan, type UndoRow, type UndoState, type UndoStep, type UndoVariant,
} from './change-undo.js';
import { editSkippedTransactions, withoutSkipped, withSkipped } from './skipped-transactions.js';
import type { SecretGet, SecretSet } from './subscription-prefs.js';
import { rowIdByComment, txIdFromComment } from './sync-core.js';
import type { HostActivity, SyncHost } from './sync-host.js';
import {
  clearAccountOverride, clearTxOverride, editSyncOverrides, isUnreadableOverridesError, setAccountOverride, setTxOverride,
  type SyncOverrides,
} from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import type { MappingRule } from './types.js';

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
    create(rule: { name: string; pattern: string; categoryId: string }): Promise<string | null>;
    remove(id: string): Promise<void>;
    /** The charges the rule filed (assignment source "rule", its category, a note
     *  containing its words), by activity id. Null when that cannot be read. */
    filedBy(rule: { categoryId: string; pattern: string }): Promise<string[] | null>;
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

/** The row as the planner sees it, with "is it one half of a linked transfer". */
async function toUndoRow(io: UndoIo, a: HostActivity, txKey: string | null): Promise<UndoRow> {
  let linked: boolean;
  if (io.host.capabilities.readsSourceGroupId) {
    linked = !!a.sourceGroupId;
  } else {
    // The add-on cannot read groups back; the ledger the sync keeps stands in.
    const ledger = parseJson<Record<string, string>>(await io.secrets.get(LINKED_GROUPS_SECRET_KEY)) ?? {};
    const txId = txIdFromComment(a.comment);
    linked = (!!txKey && ledger[txKey] !== undefined) || (!!txId && ledger[txId] !== undefined);
  }
  return {
    id: a.id, accountId: a.accountId, type: a.activityType, date: a.date.slice(0, 10),
    absCents: cents(a.amount), comment: a.comment ?? '', linked,
  };
}

/** The entry's row as it stands now, or null. */
async function findRow(io: UndoIo, entry: ChangeEntry, latest: ChangeEntry | null, key: string | null): Promise<UndoRow | null> {
  const after = rec(entry.after);
  const wf = entry.account?.wfId ?? str(after.accountId);
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
  const needsCurrency = ['balance-correction', 'starting-balance', 'starting-balance-moved', 'amazon-label'].includes(entry.kind);
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
      state.row = await findRow(io, entry, latest, key);
      return state;
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
async function perform(io: UndoIo, steps: UndoStep[], now: Date): Promise<string | null> {
  let created: string | null = null;
  for (const s of steps) {
    switch (s.do) {
      case 'skip':
        await editSkippedTransactions(io.secrets.get, io.secrets.set, (l) => withSkipped(l, {
          account: s.account, txId: s.txId, note: UNDO_SKIP_NOTE, at: now.toISOString(),
        }));
        break;
      case 'unskip':
        await editSkippedTransactions(io.secrets.get, io.secrets.set, (l) => withoutSkipped(l, s.account, s.txId));
        break;
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
  const available = undoAvailability(entry, io.where);
  if (available.kind === 'none') return { ok: false, message: UNDO_NOT_POSSIBLE };
  if (available.kind !== 'ready') return { ok: false, message: available.text };
  const latest = latestReversal(entries, entry.id);

  let state: UndoState;
  try {
    state = await gather(io, entry, op, latest, variant);
  } catch (err) {
    return { ok: false, message: err instanceof Refusal ? err.message : UNDO_UNREACHABLE };
  }
  const decision = planChangeUndo(entry, op, state, { latest, variant });
  if (!decision.ok) return { ok: false, message: decision.reason };
  const p = decision.plan;

  const overrideSteps = p.steps.filter(isOverrideStep);
  const rest = p.steps.filter((s) => !isOverrideStep(s));
  if (overrideSteps.length > 0) {
    try {
      await editSyncOverrides(io.secrets.get, io.secrets.set, (o) => overrideSteps.reduce((d, s) => applyOverride(d, s, now, entry.id), o), now);
    } catch (err) {
      return { ok: false, message: isUnreadableOverridesError(err) ? message(err) : UNDO_UNREACHABLE };
    }
  }

  let created: string | null;
  try {
    created = await perform(io, rest, now);
  } catch (err) {
    if (err instanceof Refusal) {
      // Refused as an exact copy: take the override back out, so nothing changed.
      if (overrideSteps.length > 0) {
        await editSyncOverrides(io.secrets.get, io.secrets.set, (o) => overrideSteps.reduce(rollbackOverride, o), now).catch(() => {});
      }
      return { ok: false, message: err.message };
    }
    const what = op === 'undo' ? 'undo' : 'redo';
    return { ok: false, message: `Couldn't finish the ${what}: ${message(err)}` };
  }

  try {
    await io.record(reversalChange(entry, op, reversalExtra(p, created, state)));
  } catch {
    // Never costs the undo: the writer records a gap instead.
  }
  return { ok: true, message: p.done, needsSync: p.needsSync };
}
