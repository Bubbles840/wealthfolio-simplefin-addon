/**
 * shared/change-undo.ts
 *
 * Undo and Redo of a change-log entry, decided purely: (entry, what is there
 * now) → a plan of steps, or a refusal that says why. Nothing here reads or
 * writes; `shared/change-undo-run.ts` gathers the state, runs the plan on a
 * host and records the result. Both surfaces — `/changes` and the app's Change
 * log card — go through the same planner, so an Undo means one thing.
 *
 * The principle (spec B2): the sync owns the books. Undo of a SYNC decision
 * records an override (shared/sync-overrides.ts) and the next sync acts on it;
 * filings, rules and the sync's own correction rows are reversed directly.
 *
 * Every plan puts its override steps FIRST: an override left behind by a
 * reversal that then failed is harmless, and the failure is reported.
 */
import { bankDayInstant } from './bank-day.js';
import { BUDGET_TAXONOMY, DEFAULT_PERIOD_KEY, isClearedDefault, type BudgetTarget } from './budget-suggest.js';
import { changeMoney, type ChangeEntry } from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import { sameMappingRule } from './mapper.js';
import {
  PAYBACK_CAT_RULE_REDONE, PAYBACK_CAT_RULE_UNDONE, PAYBACK_TX_RULE_REDONE, PAYBACK_TX_RULE_UNDONE, paybackFiledSince, paybackRedone, paybackUndone,
} from './payback-copy.js';
import { isPaybackRow, paybackRetype, type PaybackRow } from './payback-row.js';
import type { ActivityWrite, ImportRow } from './sync-host.js';
import type { AccountOverrideFlag, TxOverrideFlag } from './sync-overrides.js';
import type { MappingRule } from './types.js';
import { companionUnderstandsOverrides, companionUnderstandsPaybacks, companionUnderstandsVenmoNotes } from './version.js';

export type UndoOp = 'undo' | 'redo';
/** A rule's Undo comes in two: the rule alone, or the rule and the charges it filed. */
export type UndoVariant = 'plain' | 'unfile';

/** Kinds whose undo the SYNC carries out (an override): gated on the companion's version. */
export const SYNC_DECISION_KINDS: ReadonlySet<string> = new Set([
  'transfer-link', 'transfer-type', 'duplicate-removed', 'balance-correction', 'import', 'amazon-label', 'venmo-note',
]);
/** Kinds only the companion can reverse: the add-on SDK has no category, rule
 *  or budget API — and a payback's Undo takes a category off (1.62, W7). */
export const COMPANION_ONLY_KINDS: ReadonlySet<string> = new Set([
  'category-filed', 'opening-balance-filed', 'category-rule-created', 'budget-set', 'payback-filed',
]);
export const UNDO_KINDS: ReadonlySet<string> = new Set([
  ...SYNC_DECISION_KINDS, ...COMPANION_ONLY_KINDS, 'mapping-rule-created', 'starting-balance', 'starting-balance-moved',
  'starting-balance-removed', 'transaction-removed',
]);

export const SPENDING_TAXONOMY = 'spending_categories';

// ── Copy (both surfaces) ─────────────────────────────────────────────────
export const UNDO_UPDATE_COMPANION = 'Update the companion first';
/** Telegram, for a Venmo note's Undo or Redo while the installed add-on is
 *  older than `VENMO_NOTE_SINCE`, or unknown (see `addonGateCovers`). It names
 *  the app too, so a companion that cannot see the add-ons directory still
 *  points somewhere that works (ruling P3-L). */
export const UNDO_UPDATE_ADDON = "Update the add-on first — or undo it from the app's Change log.";
/** The app, when the companion's version could not be read: a gated undo waits. */
export const UNDO_VERSION_UNKNOWN = "Couldn't check the companion's version — nothing was changed. Try again.";
export const UNDO_FROM_TELEGRAM = 'Undo this from Telegram: /changes';
export const REDO_FROM_TELEGRAM = 'Redo this from Telegram: /changes';
export const UNDO_TAKES_EFFECT = 'Takes effect on the next sync.';
export const UNDO_LINKED_REFUSAL = 'Undo the transfer link first.';
/** The app, for a transfer-typed row it cannot tell is linked (it reads no groups). */
export const UNDO_MAYBE_LINKED = 'This may be half of a linked transfer — undo the link first, or undo it from Telegram: /changes';
export const UNDO_UNREACHABLE = "Couldn't reach Wealthfolio — nothing undone.";
export const UNDO_ALREADY_UNDONE = 'That one is already undone.';
export const UNDO_NOT_UNDONE = "That one isn't undone — nothing to redo.";
export const UNDO_NOT_POSSIBLE = "This change can't be undone.";
export const UNDO_NO_KEY = "Couldn't tell which bank transaction this is — nothing was changed.";
export const UNDO_NO_ACCOUNT = "Couldn't tell which account this is — nothing was changed.";
export const UNDO_EXACT_COPY = 'Wealthfolio refused it as an exact copy of a transaction it already has — nothing changed.';
/** A removed row's create request, or null when it cannot be re-created: an
 *  account, type, date and note, a finite positive amount and a currency. */
export function createPayloadOf(raw: unknown): ActivityWrite | null {
  const p = rec(raw);
  const amount = Number(p.amount);
  if (!str(p.accountId) || !str(p.activityType) || !str(p.activityDate) || typeof p.comment !== 'string') return null;
  if (typeof p.amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || !str(p.currency)) return null;
  return p as unknown as ActivityWrite;
}

export const undoChangedSince = (op: UndoOp) => `It has changed since — nothing was ${op === 'undo' ? 'undone' : 'redone'}.`;
export const undoGone = (op: UndoOp) => `That transaction is gone — nothing was ${op === 'undo' ? 'undone' : 'redone'}.`;

export type UndoAvailability =
  | { kind: 'ready'; op: UndoOp }
  /** The app, for a kind only the companion can undo. */
  | { kind: 'telegram'; op: UndoOp; text: string }
  /** The app, for a sync decision while the companion is too old to obey overrides. */
  | { kind: 'update-companion'; op: UndoOp; text: string }
  | { kind: 'none' };

/**
 * What an entry offers, where. Never for an entry that is itself an undo or a
 * redo (you reverse the original). In the app, a category or rule entry points
 * at Telegram — only when a companion runs — and a sync decision's Undo waits
 * for a companion that obeys overrides. The companion is new by definition.
 */
export function undoAvailability(
  entry: ChangeLogItem,
  where: { host: 'addon' | 'companion'; companionVersion: string | null },
): UndoAvailability {
  if (!entry.undoable || entry.reverses || !UNDO_KINDS.has(entry.kind)) return { kind: 'none' };
  const op: UndoOp = entry.undone ? 'redo' : 'undo';
  if (where.host === 'addon' && COMPANION_ONLY_KINDS.has(entry.kind)) {
    if (!where.companionVersion) return { kind: 'none' };
    // A payback's Undo and Redo run in Telegram, on a companion that knows paybacks (W8).
    if (entry.kind === 'payback-filed' && !companionUnderstandsPaybacks(where.companionVersion)) {
      return { kind: 'update-companion', op, text: UNDO_UPDATE_COMPANION };
    }
    return { kind: 'telegram', op, text: op === 'undo' ? UNDO_FROM_TELEGRAM : REDO_FROM_TELEGRAM };
  }
  if (where.host === 'addon' && companionGateCovers(entry, op) && !companionUnderstands(entry, where.companionVersion)) {
    return { kind: 'update-companion', op, text: UNDO_UPDATE_COMPANION };
  }
  return { kind: 'ready', op };
}

/** The companion this entry's override needs: one that obeys overrides at all,
 *  and for a Venmo note one that also reads `noVenmoNote` (ruling P3-K). */
function companionUnderstands(entry: Pick<ChangeEntry, 'kind'>, companionVersion: string | null): boolean {
  return companionUnderstandsOverrides(companionVersion)
    && (entry.kind !== 'venmo-note' || companionUnderstandsVenmoNotes(companionVersion));
}

/**
 * In Telegram, this waits for the INSTALLED add-on to read the override it
 * touches: a Venmo note's Undo writes `noVenmoNote`, its Redo clears it, and an
 * add-on older than `VENMO_NOTE_SINCE` reads the whole overrides document as
 * corrupt while the flag is there (see `VENMO_NOTE_SINCE`); a payback's Undo
 * and Redo touch `asReimbursement`, which an add-on older than `PAYBACK_SINCE`
 * ignores (W8), and so does the Undo/Redo of the W10 transaction rule (M6). The runner reads the installed version and refuses with
 * `UNDO_UPDATE_ADDON`, or for a payback `PAYBACK_UPDATE_ADDON`.
 */
export function addonGateCovers(entry: Pick<ChangeEntry, 'kind' | 'after'>): boolean {
  return entry.kind === 'venmo-note' || isPaybackEntry(entry);
}

/** An entry whose Undo or Redo an older INSTALLED add-on would get wrong: a payback filed, or
 *  the W10 transaction rule that makes deposits paybacks (an older add-on reads that rule
 *  without its money-in, account and `since` limits — direction-blind, every account). */
export function isPaybackEntry(entry: Pick<ChangeEntry, 'kind' | 'after'>): boolean {
  if (entry.kind === 'payback-filed') return true;
  if (entry.kind !== 'mapping-rule-created') return false;
  const rule = (entry.after as { rule?: { activityType?: unknown; subtype?: unknown; onlyMoneyIn?: unknown } } | undefined)?.rule;
  return !!rule && rule.activityType === 'CREDIT' && rule.subtype === 'REIMBURSEMENT' && rule.onlyMoneyIn === true;
}

/** A sync decision whose undo is an override the sync must obey: an automatic
 *  one, and a transfer link whoever made it — 2c R2 links as `you`, and its
 *  Undo is still `notTransfer` on both legs, which only a sync carries out. */
export function needsOverrideSupport(entry: Pick<ChangeEntry, 'kind' | 'actor'>): boolean {
  return SYNC_DECISION_KINDS.has(entry.kind) && (entry.actor === 'auto' || entry.kind === 'transfer-link');
}

/** In the app, this waits for a companion that obeys overrides: the Undo of
 *  an automatic sync decision (a Redo only clears overrides). */
export function companionGateCovers(entry: Pick<ChangeEntry, 'kind' | 'actor'>, op: UndoOp): boolean {
  return op === 'undo' && needsOverrideSupport(entry);
}

/** The newest undo or redo of `id` in a newest-first list, or null. */
export function latestReversal(entries: readonly ChangeEntry[], id: string): ChangeEntry | null {
  return entries.find((e) => e.reverses?.id === id) ?? null;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The row the entry's next undo or redo acts on. A reversal records the row it
 * left behind (`after.activityId`, absent when it removed the row), so after
 * the first one THAT is the answer; before it, the entry's own row.
 */
export function currentRowId(entry: ChangeEntry, latest: ChangeEntry | null): string | null {
  if (latest) return str(rec(latest.after).activityId);
  switch (entry.kind) {
    case 'balance-correction':
    case 'starting-balance':
      return str(rec(entry.after).activityId) ?? entry.subject.activityIds?.[0] ?? null;
    case 'starting-balance-moved':
      return str(rec(entry.before).activityId) ?? entry.subject.activityIds?.[0] ?? null;
    case 'duplicate-removed':
    case 'transaction-removed':
    case 'starting-balance-removed':
      // The row was removed; there is no row until an undo puts one back.
      return null;
    default:
      return entry.subject.activityIds?.[0] ?? null;
  }
}

/** The category rule the next undo or redo acts on (null: none known by id). */
export function currentRuleId(entry: ChangeEntry, latest: ChangeEntry | null): string | null {
  return latest ? str(rec(latest.after).ruleId) : str(rec(entry.after).ruleId);
}

/** The budget target the next undo acts on: the entry's, or the one the last
 *  Redo created (null after an Undo). */
export function currentBudgetTargetId(entry: ChangeEntry, latest: ChangeEntry | null): string | null {
  return latest ? str(rec(latest.after).targetId) : str(rec(entry.after).targetId);
}

/** A row as the planner needs it, re-read by the runner. */
export interface UndoRow {
  id: string;
  accountId: string;
  type: string;
  date: string;
  absCents: number;
  comment: string;
  /**
   * One half of a linked transfer — deleting it deletes both halves, and an
   * update to it is copied onto the other. `confirmed`: the row's group says so
   * (the companion), or the sync's ledger does (the add-on). `maybe`: the add-on
   * reads no groups and its ledger knows only its own links, so a transfer-typed
   * row nothing marks as unpaired may be half of a pair the companion linked.
   */
  linked: 'confirmed' | 'maybe' | false;
}

/** What is there now, read by the runner — each kind reads only what it needs. */
export interface UndoState {
  /** The row (`currentRowId`, or found by its tx key); null: gone. */
  row?: UndoRow | null;
  /** Category kinds: every taxonomy's assignment on the row now. */
  assignments?: Array<{ taxonomyId: string; categoryId: string }>;
  /** Rule kinds: the rule now, found by id or by name; null: none. */
  rule?: { id: string } | null;
  /** The un-file variant: what the rule filed (activity ids). */
  ruleFiled?: string[];
  mappingRules?: MappingRule[];
  /** Starting-balance redo: the account's starting-balance row now, or null. */
  startingBalanceId?: string | null;
  /** The entry's tx key, or one derived from the row's note when it has none. */
  txKey?: string | null;
  /** `budget-set`: every budget target now (`GET /spending/budget`). */
  budgetTargets?: BudgetTarget[];
  /** The account's currency, for a row written back. */
  currency?: string;
  /** `payback-filed`: the row re-read by exact id, its stored instant included; null: gone. */
  payback?: PaybackRow | null;
  /** `payback-filed` with no category, on a row that is still a deposit: whether
   *  `asReimbursement` is set on at least one of the entry's keys. */
  paybackFlagged?: boolean;
}

export type UndoStep =
  | { do: 'set-tx'; txKey: string; flag: TxOverrideFlag; label: string }
  | { do: 'clear-tx'; txKey: string; flag: TxOverrideFlag }
  | { do: 'set-account'; sfinId: string; flag: AccountOverrideFlag; label: string }
  | { do: 'clear-account'; sfinId: string; flag: AccountOverrideFlag }
  | { do: 'skip'; account: string; txId: string }
  | { do: 'unskip'; account: string; txId: string }
  | { do: 'delete'; activityId: string }
  /** Re-create a removed duplicate. A refusal as an exact copy rolls back the plan's overrides. */
  | { do: 'create'; write: ActivityWrite }
  /** Put a starting balance or a correction back (the import endpoint); the id is read back by note. */
  | { do: 'import'; row: ImportRow }
  | { do: 'update'; write: ActivityWrite }
  | { do: 'assign'; activityId: string; taxonomyId: string; categoryId: string }
  | { do: 'unassign'; activityId: string; taxonomyId: string }
  | { do: 'delete-rule'; ruleId: string }
  | { do: 'create-rule'; rule: { name: string; pattern: string; categoryId: string; accountId?: string; activityType?: string } }
  | { do: 'mapping-remove'; rule: MappingRule }
  | { do: 'mapping-add'; rule: MappingRule; index?: number }
  | { do: 'delete-budget'; targetId: string }
  /** A category's default monthly budget; the id is read back from Wealthfolio's reply. */
  | { do: 'set-budget'; categoryId: string; amountCents: number };

export interface UndoPlan {
  op: UndoOp;
  steps: UndoStep[];
  /** A sync carries it out: the surface says "Takes effect on the next sync." and offers Sync now. */
  needsSync: boolean;
  /** What to say when it worked. */
  done: string;
  /** The row after this plan: its id, null when it removes the row, 'created'
   *  when a `create`/`import` step makes it, undefined for kinds without one. */
  rowAfter?: string | null | 'created';
  /** The rule after this plan, likewise. */
  ruleAfter?: null | 'created';
  /** The budget target after this plan, likewise. */
  budgetAfter?: null | 'created';
}

export type UndoDecision = { ok: true; plan: UndoPlan } | { ok: false; reason: string };

const refuse = (reason: string): UndoDecision => ({ ok: false, reason });
const plan = (p: UndoPlan): UndoDecision => ({ ok: true, plan: p });
/** Why a row that may be half of a linked transfer cannot be changed alone, or null. */
const linkedRefusal = (row: UndoRow | null | undefined): string | null =>
  (row?.linked === 'confirmed' ? UNDO_LINKED_REFUSAL : row?.linked === 'maybe' ? UNDO_MAYBE_LINKED : null);

/** What an override is called in the overrides list: the bank text and the account. */
function labelOf(entry: ChangeEntry, accountName?: string, description?: string): string {
  const what = (description ?? entry.subject.description)?.trim() || 'a transaction';
  const where = accountName ?? entry.account?.name;
  return where ? `${what} · ${where}` : what;
}

/**
 * A linked leg's own bank text. Each leg records it; a link logged before that
 * names the out-leg in its subject and both legs in its summary
 * ("Linked <out> and <in> as one transfer").
 */
function legDescription(entry: ChangeEntry, leg: Record<string, unknown> | undefined, i: number): string | undefined {
  const own = str(leg?.description);
  if (own) return own;
  if (i === 0) return undefined;
  const out = entry.subject.description?.trim() || 'a transaction';
  const head = `Linked ${out} and `;
  const tail = ' as one transfer';
  const s = entry.summary;
  return s.startsWith(head) && s.endsWith(tail) && s.length > head.length + tail.length
    ? s.slice(head.length, s.length - tail.length)
    : undefined;
}

/** The logged rule, with a payback rule's limits (W10): a Redo puts back exactly that rule. */
function mappingRuleOf(entry: ChangeEntry): MappingRule | null {
  const r = rec(rec(entry.after).rule);
  const pattern = str(r.pattern);
  const matchType = r.matchType === 'contains' || r.matchType === 'regex' ? r.matchType : null;
  const activityType = str(r.activityType);
  if (!pattern || !matchType || !activityType) return null;
  return {
    pattern, matchType, activityType: activityType as MappingRule['activityType'],
    ...(str(r.subtype) ? { subtype: str(r.subtype)! } : {}),
    ...(r.onlyMoneyIn === true ? { onlyMoneyIn: true as const } : {}),
    ...(str(r.accountId) ? { accountId: str(r.accountId)! } : {}),
    ...(str(r.since) ? { since: str(r.since)! } : {}),
  };
}

/**
 * Decide an undo or a redo. `latest` is the newest undo/redo of this entry
 * (`latestReversal`): it says whether the entry is undone now and which row or
 * rule the reversal left behind.
 */
export function planChangeUndo(
  entry: ChangeEntry,
  op: UndoOp,
  state: UndoState,
  opts: { latest: ChangeEntry | null; variant?: UndoVariant },
): UndoDecision {
  if (!entry.undoable || entry.reverses || !UNDO_KINDS.has(entry.kind)) return refuse(UNDO_NOT_POSSIBLE);
  const undone = opts.latest?.reverses?.op === 'undo';
  if (op === 'undo' && undone) return refuse(UNDO_ALREADY_UNDONE);
  if (op === 'redo' && !undone) return refuse(UNDO_NOT_UNDONE);
  const before = rec(entry.before);
  const after = rec(entry.after);
  const rowNow = currentRowId(entry, opts.latest);
  const currency = state.currency ?? 'USD';
  const key = state.txKey ?? entry.subject.txKeys?.[0] ?? null;
  const sfinId = entry.account?.sfinId ?? null;

  switch (entry.kind) {
    case 'category-filed': {
      const taxonomy = str(after.taxonomyId) ?? str(before.taxonomyId) ?? SPENDING_TAXONOMY;
      const current = state.assignments ?? [];
      const activityId = entry.subject.activityIds?.[0];
      const prior = Array.isArray(before.assignments)
        ? (before.assignments as unknown[]).map(rec).map((a) => ({ taxonomyId: str(a.taxonomyId), categoryId: str(a.categoryId) }))
          .filter((a): a is { taxonomyId: string; categoryId: string } => !!a.taxonomyId && !!a.categoryId)
        : null;
      const beforeTaxonomy = str(before.taxonomyId);
      // A move across taxonomies (or one that recorded its complete prior state):
      // a redo must check, and clear, the slots the undo restored, not the target's.
      const isMove = !!prior || (!!beforeTaxonomy && beforeTaxonomy !== taxonomy);
      const priorSet = prior ?? (isMove && str(before.categoryId) ? [{ taxonomyId: beforeTaxonomy!, categoryId: str(before.categoryId)! }] : []);
      const now = current.find((a) => a.taxonomyId === taxonomy)?.categoryId ?? null;
      const [expected, target] = op === 'undo'
        ? [str(after.categoryId), str(before.categoryId)]
        : [str(before.categoryId), str(after.categoryId)];
      if (op === 'redo' && isMove) {
        const restored = priorSet.every((p) => current.some((a) => a.taxonomyId === p.taxonomyId && a.categoryId === p.categoryId));
        const targetFree = now === null || priorSet.some((p) => p.taxonomyId === taxonomy && p.categoryId === now);
        if (!restored || !targetFree) return refuse(undoChangedSince(op));
      } else if (now !== expected) {
        return refuse(undoChangedSince(op));
      }
      if (!activityId) return refuse(UNDO_NOT_POSSIBLE);
      const steps: UndoStep[] = [];
      // An automatic filing would be made again by the next sync's filer.
      if (entry.actor === 'auto') {
        if (!key) return refuse(UNDO_NO_KEY);
        steps.push(op === 'undo'
          ? { do: 'set-tx', txKey: key, flag: 'noAutoFile', label: labelOf(entry) }
          : { do: 'clear-tx', txKey: key, flag: 'noAutoFile' });
      }
      if (op === 'undo' && prior) {
        // A move's complete prior state: every taxonomy as it was.
        for (const a of current) {
          if (!prior.some((p) => p.taxonomyId === a.taxonomyId)) steps.push({ do: 'unassign', activityId, taxonomyId: a.taxonomyId });
        }
        for (const p of prior) {
          const cur = current.find((a) => a.taxonomyId === p.taxonomyId);
          if (cur?.categoryId === p.categoryId) continue;
          if (cur) steps.push({ do: 'unassign', activityId, taxonomyId: p.taxonomyId });
          steps.push({ do: 'assign', activityId, taxonomyId: p.taxonomyId, categoryId: p.categoryId });
        }
      } else if (op === 'redo' && isMove) {
        // Take the restored prior state off, then file the move's target.
        const slots = new Set([...priorSet.map((p) => p.taxonomyId), ...(now !== null ? [taxonomy] : [])]);
        for (const t of slots) steps.push({ do: 'unassign', activityId, taxonomyId: t });
        if (target) steps.push({ do: 'assign', activityId, taxonomyId: taxonomy, categoryId: target });
      } else if (target === null) {
        steps.push({ do: 'unassign', activityId, taxonomyId: taxonomy });
      } else {
        if (now !== null) steps.push({ do: 'unassign', activityId, taxonomyId: taxonomy });
        steps.push({ do: 'assign', activityId, taxonomyId: taxonomy, categoryId: target });
      }
      const name = str(op === 'undo' ? before.categoryName : after.categoryName);
      return plan({
        op, steps, needsSync: false, rowAfter: activityId,
        done: `${op === 'undo' ? 'Undone' : 'Redone'} — ${name ? `filed under ${name}` : 'no category'}.`,
      });
    }

    case 'opening-balance-filed': {
      if (!sfinId) return refuse(UNDO_NO_ACCOUNT);
      const activityId = entry.subject.activityIds?.[0];
      const categoryId = str(after.categoryId);
      if (!activityId || !categoryId) return refuse(UNDO_NOT_POSSIBLE);
      const now = (state.assignments ?? []).find((a) => a.taxonomyId === SPENDING_TAXONOMY)?.categoryId ?? null;
      if (now !== (op === 'undo' ? categoryId : null)) return refuse(undoChangedSince(op));
      return plan(op === 'undo'
        ? {
          op, needsSync: false, rowAfter: activityId, done: 'Undone — the opening balance has no category, and stays that way.',
          steps: [
            { do: 'set-account', sfinId, flag: 'noOpeningFile', label: entry.account?.name ?? sfinId },
            { do: 'unassign', activityId, taxonomyId: SPENDING_TAXONOMY },
          ],
        }
        : {
          op, needsSync: false, rowAfter: activityId, done: `Redone — filed under ${str(after.categoryName) ?? 'its category'}.`,
          steps: [
            { do: 'clear-account', sfinId, flag: 'noOpeningFile' },
            { do: 'assign', activityId, taxonomyId: SPENDING_TAXONOMY, categoryId },
          ],
        });
    }

    case 'category-rule-created': {
      const name = str(after.name);
      const pattern = str(after.pattern);
      const categoryId = str(after.categoryId);
      // A rule scoped to one account (3, L5) comes back scoped, and a payback
      // rule's activity type (W10) with it.
      const accountId = str(after.accountId);
      const activityType = str(after.activityType);
      if (!name || !pattern || !categoryId) return refuse(UNDO_NOT_POSSIBLE);
      if (op === 'redo') {
        if (state.rule) return refuse('That rule is already there.');
        return plan({
          op, needsSync: false, ruleAfter: 'created', done: activityType === 'CREDIT' ? PAYBACK_CAT_RULE_REDONE : 'Redone — the rule is back.',
          steps: [{
            do: 'create-rule',
            rule: { name, pattern, categoryId, ...(accountId ? { accountId } : {}), ...(activityType ? { activityType } : {}) },
          }],
        });
      }
      if (!state.rule) return refuse('That rule is already gone.');
      const steps: UndoStep[] = [{ do: 'delete-rule', ruleId: state.rule.id }];
      if (opts.variant === 'unfile') {
        for (const id of state.ruleFiled ?? []) steps.push({ do: 'unassign', activityId: id, taxonomyId: SPENDING_TAXONOMY });
      }
      const n = opts.variant === 'unfile' ? (state.ruleFiled ?? []).length : 0;
      return plan({
        op, steps, needsSync: false, ruleAfter: null,
        done: opts.variant === 'unfile'
          ? `Undone — the rule is gone and ${n} ${n === 1 ? 'charge is' : 'charges are'} back in the needs-a-category list.`
          : activityType === 'CREDIT' ? PAYBACK_CAT_RULE_UNDONE : 'Undone — the rule is gone.',
      });
    }

    case 'budget-set': {
      const categoryId = str(after.categoryId);
      const amountCents = num(after.amountCents);
      const name = str(after.categoryName) ?? 'That category';
      if (!categoryId || amountCents === null) return refuse(UNDO_NOT_POSSIBLE);
      const targets = state.budgetTargets ?? [];
      if (op === 'redo') {
        // Never over a budget set since: Wealthfolio's POST would overwrite it. Only a
        // DEFAULT blocks (a $0 one is Wealthfolio's cleared state, not a budget): a this-month target is untouched by the default POST and sat
        // beside the default before the Undo, so it deliberately does not block Redo.
        const again = targets.some((t) => t.targetType === 'category' && t.taxonomyId === BUDGET_TAXONOMY
          && t.categoryId === categoryId && t.periodKey === DEFAULT_PERIOD_KEY && !isClearedDefault(t));
        if (again) return refuse(`${name} has a budget again — nothing was redone.`);
        return plan({
          op, needsSync: false, budgetAfter: 'created', done: `Redone — ${name} has its ${changeMoney(amountCents)} budget back.`,
          steps: [{ do: 'set-budget', categoryId, amountCents }],
        });
      }
      const id = currentBudgetTargetId(entry, opts.latest);
      // No id known (a Redo whose reply named no target, or an entry recorded without
      // one): a live entry's budget is the category's default target.
      const live = !opts.latest || opts.latest.reverses?.op === 'redo';
      const now = id ? targets.find((t) => t.id === id)
        : live ? targets.find((t) => t.targetType === 'category' && t.taxonomyId === BUDGET_TAXONOMY
          && t.categoryId === categoryId && t.periodKey === DEFAULT_PERIOD_KEY) : undefined;
      if (!now) return refuse('That budget is already gone — nothing was undone.');
      if (now.amountCents !== amountCents || now.periodKey !== DEFAULT_PERIOD_KEY || now.categoryId !== categoryId) {
        return refuse(undoChangedSince(op));
      }
      return plan({
        op, needsSync: false, budgetAfter: null, done: `Undone — ${name} has no budget.`,
        steps: [{ do: 'delete-budget', targetId: now.id }],
      });
    }

    case 'mapping-rule-created': {
      const rule = mappingRuleOf(entry);
      if (!rule) return refuse(UNDO_NOT_POSSIBLE);
      const present = (state.mappingRules ?? []).some((r) => sameMappingRule(r, rule));
      if (op === 'undo' && !present) return refuse('That transaction rule is already gone.');
      if (op === 'redo' && present) return refuse('That transaction rule is already there.');
      // A payback rule (W10) sits first in the list and comes back there: its
      // logged index, or first when the list no longer has room for it.
      const payback = rule.onlyMoneyIn === true && rule.subtype === 'REIMBURSEMENT';
      const index = num(rec(entry.after).index);
      const done = payback
        ? (op === 'undo' ? PAYBACK_TX_RULE_UNDONE : PAYBACK_TX_RULE_REDONE)
        : (op === 'undo' ? 'Undone — the rule is gone.' : 'Redone — the rule is back.');
      return plan({
        op, needsSync: true, done,
        steps: [op === 'undo' ? { do: 'mapping-remove', rule } : { do: 'mapping-add', rule, ...(index !== null ? { index } : {}) }],
      });
    }

    case 'transfer-link':
    case 'transfer-type': {
      const keys = entry.subject.txKeys ?? [];
      if (keys.length === 0) return refuse(UNDO_NO_KEY);
      const legs = Array.isArray(after.legs) ? (after.legs as unknown[]).map(rec) : [];
      const steps: UndoStep[] = keys.map((txKey, i) => (op === 'undo'
        ? {
          do: 'set-tx', txKey, flag: 'notTransfer',
          label: labelOf(entry, str(legs[i]?.accountName) ?? undefined, legDescription(entry, legs[i], i)),
        } as const
        : { do: 'clear-tx', txKey, flag: 'notTransfer' } as const));
      return plan({
        op, steps, needsSync: true,
        done: op === 'undo'
          ? `Undone — the next sync counts ${keys.length === 2 ? 'each half' : 'it'} as spending or money in.`
          : `Redone — the next sync can treat ${keys.length === 2 ? 'them' : 'it'} as a transfer again.`,
      });
    }

    case 'balance-correction': {
      const auto = entry.actor === 'auto';
      if (auto && !sfinId) return refuse(UNDO_NO_ACCOUNT);
      const amountCents = num(after.amountCents);
      const comment = str(after.comment);
      const accountId = str(after.accountId) ?? entry.account?.wfId ?? null;
      if (amountCents === null || !comment || !accountId) return refuse(UNDO_NOT_POSSIBLE);
      if (op === 'undo') {
        const row = state.row;
        if (!row) return refuse(`That correction is gone — nothing was undone.`);
        if (row.absCents !== Math.abs(amountCents) || row.comment !== comment) return refuse(undoChangedSince(op));
        return plan({
          op, needsSync: false, rowAfter: null, done: 'Undone — the correction is gone.',
          steps: [
            ...(auto ? [{ do: 'set-account', sfinId: sfinId!, flag: 'noAutoCorrect', label: entry.account?.name ?? sfinId! } as const] : []),
            { do: 'delete', activityId: row.id },
          ],
        });
      }
      if (state.row) return refuse('That correction is already there.');
      const activityType = str(after.activityType);
      const date = str(after.date);
      if (!activityType || !date) return refuse(UNDO_NOT_POSSIBLE);
      return plan({
        op, needsSync: false, rowAfter: 'created', done: 'Redone — the correction is back.',
        steps: [
          ...(auto ? [{ do: 'clear-account', sfinId: sfinId!, flag: 'noAutoCorrect' } as const] : []),
          {
            do: 'import',
            row: {
              // A recorded BARE day is written at noon UTC like any bank day (the timestamp it was recorded as is put back as it was).
              accountId, sourceSystem: 'simplefin', activityType, date: bankDayInstant(date), symbol: `$CASH-${currency}`,
              amount: Math.abs(amountCents) / 100, fee: 0, currency, comment, isValid: true, isDraft: false,
            },
          },
        ],
      });
    }

    case 'starting-balance': {
      const amountCents = num(after.amountCents);
      const date = str(after.date);
      const comment = str(after.comment);
      const activityType = str(after.activityType);
      const accountId = entry.account?.wfId ?? null;
      if (amountCents === null || !date || !comment || !activityType || !accountId) return refuse(UNDO_NOT_POSSIBLE);
      if (op === 'undo') {
        const row = state.row;
        if (!row) return refuse('That starting balance is gone — nothing was undone.');
        if (row.absCents !== Math.abs(amountCents) || row.date !== date) return refuse(undoChangedSince(op));
        return plan({
          op, needsSync: false, rowAfter: null, steps: [{ do: 'delete', activityId: row.id }],
          done: "Undone — the starting balance is gone, so the account may no longer match the bank's balance.",
        });
      }
      if (state.startingBalanceId) return refuse('This account has a starting balance again.');
      return plan({
        op, needsSync: false, rowAfter: 'created', done: 'Redone — the starting balance is back.',
        steps: [{
          do: 'import',
          row: {
            accountId, sourceSystem: 'simplefin', activityType, date: bankDayInstant(date), symbol: `$CASH-${currency}`,
            amount: Math.abs(amountCents) / 100, currency, comment, isValid: true, isDraft: false,
          },
        }],
      });
    }

    case 'starting-balance-moved': {
      const [from, to] = op === 'undo' ? [after, before] : [before, after];
      const fromCents = num(from.amountCents);
      const toCents = num(to.amountCents);
      const toDate = str(to.date);
      const toType = str(to.activityType);
      if (fromCents === null || toCents === null || !toDate || !toType) return refuse(UNDO_NOT_POSSIBLE);
      const row = state.row;
      if (!row) return refuse('That starting balance is gone — nothing was changed.');
      if (row.absCents !== Math.abs(fromCents) || row.date !== str(from.date)) return refuse(undoChangedSince(op));
      return plan({
        op, needsSync: false, rowAfter: row.id,
        steps: [{
          do: 'update',
          write: { id: row.id, accountId: row.accountId, activityType: toType, activityDate: bankDayInstant(toDate), amount: Math.abs(toCents) / 100, currency, comment: row.comment },
        }],
        done: op === 'undo'
          ? "Undone — the starting balance is back as it was, so the account may no longer match the bank's balance."
          : 'Redone.',
      });
    }

    case 'starting-balance-removed': {
      const amountCents = num(before.amountCents);
      const date = str(before.date);
      const comment = str(before.comment);
      const activityType = str(before.activityType);
      const accountId = entry.account?.wfId ?? null;
      if (amountCents === null || !date || !comment || !activityType || !accountId) return refuse(UNDO_NOT_POSSIBLE);
      if (op === 'redo') {
        const row = state.row;
        if (!row) return refuse('That starting balance is gone already — nothing was redone.');
        if (row.absCents !== Math.abs(amountCents) || row.date !== date) return refuse(undoChangedSince(op));
        return plan({ op, needsSync: false, rowAfter: null, steps: [{ do: 'delete', activityId: row.id }], done: 'Redone — the second starting balance is gone again.' });
      }
      if (state.startingBalanceId) return refuse('That starting balance is back already.');
      return plan({
        op, needsSync: false, rowAfter: 'created',
        done: "Undone — the second starting balance is back, so the account may no longer match the bank's balance.",
        steps: [{
          do: 'import',
          row: {
            accountId, sourceSystem: 'simplefin', activityType, date: bankDayInstant(date), symbol: `$CASH-${currency}`,
            amount: Math.abs(amountCents) / 100, currency, comment, isValid: true, isDraft: false,
          },
        }],
      });
    }

    case 'duplicate-removed': {
      if (!key) return refuse(UNDO_NO_KEY);
      if (op === 'redo') {
        return plan({
          op, needsSync: true, rowAfter: rowNow, done: 'Redone — the next re-scan removes the copy again.',
          steps: [{ do: 'clear-tx', txKey: key, flag: 'keepDuplicate' }],
        });
      }
      const write = createPayloadOf(before.activity);
      // A copy an earlier undo put back is still there: keeping it is all that is left to do.
      const steps: UndoStep[] = [{ do: 'set-tx', txKey: key, flag: 'keepDuplicate', label: labelOf(entry) }];
      if (!state.row) {
        if (!write) return refuse(UNDO_NOT_POSSIBLE);
        steps.push({ do: 'create', write });
      }
      return plan({ op, steps, needsSync: false, rowAfter: state.row ? state.row.id : 'created', done: 'Undone — both copies stay.' });
    }

    case 'transaction-removed': {
      // Every key the removal put on the skip list: (SimpleFin account, tx id).
      const skipped: Array<{ account: string; txId: string }> = [];
      for (const k of entry.subject.txKeys ?? []) {
        const at = k.indexOf('\u0000');
        if (at <= 0 || at === k.length - 1) return refuse(UNDO_NO_KEY);
        skipped.push({ account: k.slice(0, at), txId: k.slice(at + 1) });
      }
      if (skipped.length === 0) return refuse(UNDO_NO_KEY);
      // Only the keys the removal itself added; an entry without the field falls back to all of them.
      const added = Array.isArray(before.addedKeys) ? new Set(before.addedKeys.filter((k): k is string => typeof k === 'string')) : null;
      const ours = added ? skipped.filter((s) => added.has(`${s.account}\u0000${s.txId}`)) : skipped;
      if (op === 'undo') {
        const payload = createPayloadOf(before.activity);
        if (!payload) return refuse(UNDO_NOT_POSSIBLE);
        // The row first: a skip entry left behind is harmless to a stored row
        // (the sync never deletes one on the list's behalf), and it is reported.
        return plan({
          op, needsSync: false, rowAfter: 'created',
          // Keys already skipped before the removal are not this Undo's to take off.
          done: ours.length > 0
            ? "Undone — it's back, and the bank feed can import it again."
            : "Undone — it's back. It was on the skip list before you removed it, and it stays there.",
          steps: [
            { do: 'create', write: payload },
            ...ours.map((s) => ({ do: 'unskip' as const, account: s.account, txId: s.txId })),
          ],
        });
      }
      const row = state.row ?? null;
      if (!row) return refuse(undoGone(op));
      const linked = linkedRefusal(row);
      if (linked) return refuse(linked);
      // Redo removes the row the Undo put back, not one edited since.
      const was = rec(before.activity);
      if (
        row.type !== str(was.activityType) || row.date !== (str(was.activityDate) ?? '').slice(0, 10)
        || row.absCents !== Math.round(Math.abs(Number(was.amount)) * 100) || row.comment !== was.comment
      ) return refuse(undoChangedSince(op));
      // The skip first, as the removal did.
      return plan({
        op, needsSync: false, rowAfter: null, done: "Redone — it's removed and won't be imported again.",
        steps: [...ours.map((s) => ({ do: 'skip' as const, account: s.account, txId: s.txId })), { do: 'delete', activityId: row.id }],
      });
    }

    case 'import': {
      if (!key || !sfinId || !key.startsWith(`${sfinId}\u0000`)) return refuse(UNDO_NO_KEY);
      const txId = key.slice(sfinId.length + 1);
      if (op === 'redo') {
        return plan({
          op, needsSync: true, rowAfter: null, done: 'Redone — the next sync imports it again.',
          steps: [{ do: 'unskip', account: sfinId, txId }],
        });
      }
      const row = state.row ?? null;
      const linked = linkedRefusal(row);
      if (linked) return refuse(linked);
      return plan({
        op, needsSync: false, rowAfter: null, done: "Undone — it's removed and won't be imported again.",
        steps: [{ do: 'skip', account: sfinId, txId }, ...(row ? [{ do: 'delete', activityId: row.id } as const] : [])],
      });
    }

    case 'amazon-label': {
      if (!key) return refuse(UNDO_NO_KEY);
      if (op === 'redo') {
        return plan({
          op, needsSync: true, rowAfter: rowNow, done: 'Redone — the next sync adds the label again.',
          steps: [{ do: 'clear-tx', txKey: key, flag: 'noAmazonLabel' }],
        });
      }
      const row = state.row;
      const beforeNote = str(before.comment);
      if (!row) return refuse(undoGone(op));
      const linked = linkedRefusal(row);
      if (linked) return refuse(linked);
      if (!beforeNote || row.comment !== str(after.comment)) return refuse(undoChangedSince(op));
      return plan({
        op, needsSync: false, rowAfter: row.id, done: 'Undone — the label is off, and stays off.',
        steps: [
          { do: 'set-tx', txKey: key, flag: 'noAmazonLabel', label: labelOf(entry) },
          { do: 'update', write: { id: row.id, accountId: row.accountId, activityType: row.type, activityDate: bankDayInstant(row.date), amount: row.absCents / 100, currency, comment: beforeNote } },
        ],
      });
    }

    // A Venmo note (3): the override first, then the old note back — as an
    // Amazon label is undone. The sync then never adds it again.
    case 'venmo-note': {
      if (!key) return refuse(UNDO_NO_KEY);
      if (op === 'redo') {
        return plan({
          op, needsSync: true, rowAfter: rowNow, done: 'Redone — the next sync adds the note again.',
          steps: [{ do: 'clear-tx', txKey: key, flag: 'noVenmoNote' }],
        });
      }
      const row = state.row;
      const beforeNote = str(before.comment);
      if (!row) return refuse(undoGone(op));
      const linked = linkedRefusal(row);
      if (linked) return refuse(linked);
      if (!beforeNote || row.comment !== str(after.comment)) return refuse(undoChangedSince(op));
      return plan({
        op, needsSync: false, rowAfter: row.id, done: 'Undone — the note is off, and stays off.',
        steps: [
          { do: 'set-tx', txKey: key, flag: 'noVenmoNote', label: labelOf(entry) },
          { do: 'update', write: { id: row.id, accountId: row.accountId, activityType: row.type, activityDate: bankDayInstant(row.date), amount: row.absCents / 100, currency, comment: beforeNote } },
        ],
      });
    }

    // A payback (1.62, W7): the override first, then the row re-typed, then the
    // category — Redo the same again. Each refuses a row that is not where the
    // last write left it.
    case 'payback-filed': {
      const keys = entry.subject.txKeys ?? [];
      if (keys.length === 0) return refuse(UNDO_NO_KEY);
      const row = state.payback ?? null;
      if (!row) return refuse(undoGone(op));
      if (row.grouped) return refuse(UNDO_LINKED_REFUSAL);
      const categoryId = str(after.categoryId);
      const categoryName = str(after.categoryName);
      const filedNow = (state.assignments ?? []).find((a) => a.taxonomyId === SPENDING_TAXONOMY)?.categoryId ?? null;
      if (op === 'undo') {
        const clears = keys.map((txKey) => ({ do: 'clear-tx', txKey, flag: 'asReimbursement' } as const));
        if (!isPaybackRow(row)) {
          // A payback setting left on a deposit (a re-type that could not be confirmed, PB-B M5) is logged with no
          // category: its Undo takes only the setting off, and only while it is there. The row is not touched.
          if (categoryId === null && row.type === 'DEPOSIT' && filedNow !== null && state.paybackFlagged) return refuse(paybackFiledSince(op));
          if (categoryId !== null || row.type !== 'DEPOSIT' || filedNow !== null || !state.paybackFlagged) {
            return refuse(undoChangedSince(op));
          }
          return plan({ op, needsSync: false, rowAfter: row.id, done: paybackUndone(categoryName), steps: clears });
        }
        // A half-done Redo leaves the payback with no filing: accept the entry's category or none, never another.
        if (filedNow !== null && filedNow !== categoryId) return refuse(categoryId === null ? paybackFiledSince(op) : undoChangedSince(op));
        return plan({
          // Said only when a filing is there NOW to come off (PB-D m1).
          op, needsSync: false, rowAfter: row.id, done: paybackUndone(filedNow ? categoryName : null),
          steps: [
            ...clears,
            // The deposit's own subtype back; '' clears REIMBURSEMENT.
            { do: 'update', write: paybackRetype(row, 'DEPOSIT', str(before.subtype) ?? '') },
            ...(filedNow ? [{ do: 'unassign', activityId: row.id, taxonomyId: SPENDING_TAXONOMY } as const] : []),
          ],
        });
      }
      // A deposit /categorize filed (income_sources) must not end up with two filings.
      if (row.type !== 'DEPOSIT' || (state.assignments ?? []).length > 0) return refuse(undoChangedSince(op));
      return plan({
        op, needsSync: false, rowAfter: row.id, done: paybackRedone(categoryName),
        steps: [
          ...keys.map((txKey) => ({ do: 'set-tx', txKey, flag: 'asReimbursement', label: labelOf(entry) } as const)),
          { do: 'update', write: paybackRetype(row, 'CREDIT', 'REIMBURSEMENT') },
          ...(categoryId ? [{ do: 'assign', activityId: row.id, taxonomyId: SPENDING_TAXONOMY, categoryId } as const] : []),
        ],
      });
    }

    default:
      return refuse(UNDO_NOT_POSSIBLE);
  }
}
