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
import type { ChangeEntry } from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import type { ActivityWrite, ImportRow } from './sync-host.js';
import type { AccountOverrideFlag, TxOverrideFlag } from './sync-overrides.js';
import type { MappingRule } from './types.js';
import { companionUnderstandsOverrides } from './version.js';

export type UndoOp = 'undo' | 'redo';
/** A rule's Undo comes in two: the rule alone, or the rule and the charges it filed. */
export type UndoVariant = 'plain' | 'unfile';

/** Kinds whose undo the SYNC carries out (an override): gated on the companion's version. */
export const SYNC_DECISION_KINDS: ReadonlySet<string> = new Set([
  'transfer-link', 'transfer-type', 'duplicate-removed', 'balance-correction', 'import', 'amazon-label',
]);
/** Kinds only the companion can reverse: the add-on SDK has no category or rule API. */
export const COMPANION_ONLY_KINDS: ReadonlySet<string> = new Set([
  'category-filed', 'opening-balance-filed', 'category-rule-created',
]);
export const UNDO_KINDS: ReadonlySet<string> = new Set([
  ...SYNC_DECISION_KINDS, ...COMPANION_ONLY_KINDS, 'mapping-rule-created', 'starting-balance', 'starting-balance-moved',
]);

export const SPENDING_TAXONOMY = 'spending_categories';

// ── Copy (both surfaces) ─────────────────────────────────────────────────
export const UNDO_UPDATE_COMPANION = 'Update the companion first';
export const UNDO_FROM_TELEGRAM = 'Undo this from Telegram: /changes';
export const REDO_FROM_TELEGRAM = 'Redo this from Telegram: /changes';
export const UNDO_TAKES_EFFECT = 'Takes effect on the next sync.';
export const UNDO_LINKED_REFUSAL = 'Undo the transfer link first.';
export const UNDO_UNREACHABLE = "Couldn't reach Wealthfolio — nothing undone.";
export const UNDO_ALREADY_UNDONE = 'That one is already undone.';
export const UNDO_NOT_UNDONE = "That one isn't undone — nothing to redo.";
export const UNDO_NOT_POSSIBLE = "This change can't be undone.";
export const UNDO_NO_KEY = "Couldn't tell which bank transaction this is — nothing was changed.";
export const UNDO_NO_ACCOUNT = "Couldn't tell which account this is — nothing was changed.";
export const UNDO_EXACT_COPY = 'Wealthfolio refused it as an exact copy of a transaction it already has — nothing changed.';
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
    return where.companionVersion
      ? { kind: 'telegram', op, text: op === 'undo' ? UNDO_FROM_TELEGRAM : REDO_FROM_TELEGRAM }
      : { kind: 'none' };
  }
  if (where.host === 'addon' && op === 'undo' && needsOverrideSupport(entry)
    && !companionUnderstandsOverrides(where.companionVersion)) {
    return { kind: 'update-companion', op, text: UNDO_UPDATE_COMPANION };
  }
  return { kind: 'ready', op };
}

/** An automatic sync decision: its undo is an override the sync must obey. */
export function needsOverrideSupport(entry: Pick<ChangeEntry, 'kind' | 'actor'>): boolean {
  return SYNC_DECISION_KINDS.has(entry.kind) && entry.actor === 'auto';
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
      // The copy was removed; there is no row until an undo puts one back.
      return null;
    default:
      return entry.subject.activityIds?.[0] ?? null;
  }
}

/** The category rule the next undo or redo acts on (null: none known by id). */
export function currentRuleId(entry: ChangeEntry, latest: ChangeEntry | null): string | null {
  return latest ? str(rec(latest.after).ruleId) : str(rec(entry.after).ruleId);
}

/** A row as the planner needs it, re-read by the runner. */
export interface UndoRow {
  id: string;
  accountId: string;
  type: string;
  date: string;
  absCents: number;
  comment: string;
  /** One half of a linked transfer. */
  linked: boolean;
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
  /** The account's currency, for a row written back. */
  currency?: string;
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
  | { do: 'create-rule'; rule: { name: string; pattern: string; categoryId: string } }
  | { do: 'mapping-remove'; rule: MappingRule }
  | { do: 'mapping-add'; rule: MappingRule };

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
}

export type UndoDecision = { ok: true; plan: UndoPlan } | { ok: false; reason: string };

const refuse = (reason: string): UndoDecision => ({ ok: false, reason });
const plan = (p: UndoPlan): UndoDecision => ({ ok: true, plan: p });

/** What an override is called in the overrides list: the bank text and the account. */
function labelOf(entry: ChangeEntry, accountName?: string): string {
  const what = entry.subject.description?.trim() || 'a transaction';
  const where = accountName ?? entry.account?.name;
  return where ? `${what} · ${where}` : what;
}

const sameRule = (a: MappingRule, b: MappingRule) =>
  a.pattern === b.pattern && a.matchType === b.matchType && a.activityType === b.activityType && (a.subtype ?? '') === (b.subtype ?? '');

function mappingRuleOf(entry: ChangeEntry): MappingRule | null {
  const r = rec(rec(entry.after).rule);
  const pattern = str(r.pattern);
  const matchType = r.matchType === 'contains' || r.matchType === 'regex' ? r.matchType : null;
  const activityType = str(r.activityType);
  if (!pattern || !matchType || !activityType) return null;
  return { pattern, matchType, activityType: activityType as MappingRule['activityType'], ...(str(r.subtype) ? { subtype: str(r.subtype)! } : {}) };
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
      const now = current.find((a) => a.taxonomyId === taxonomy)?.categoryId ?? null;
      const [expected, target] = op === 'undo'
        ? [str(after.categoryId), str(before.categoryId)]
        : [str(before.categoryId), str(after.categoryId)];
      if (now !== expected) return refuse(undoChangedSince(op));
      const activityId = entry.subject.activityIds?.[0];
      if (!activityId) return refuse(UNDO_NOT_POSSIBLE);
      const steps: UndoStep[] = [];
      // An automatic filing would be made again by the next sync's filer.
      if (entry.actor === 'auto') {
        if (!key) return refuse(UNDO_NO_KEY);
        steps.push(op === 'undo'
          ? { do: 'set-tx', txKey: key, flag: 'noAutoFile', label: labelOf(entry) }
          : { do: 'clear-tx', txKey: key, flag: 'noAutoFile' });
      }
      const prior = Array.isArray(before.assignments)
        ? (before.assignments as unknown[]).map(rec).map((a) => ({ taxonomyId: str(a.taxonomyId), categoryId: str(a.categoryId) }))
          .filter((a): a is { taxonomyId: string; categoryId: string } => !!a.taxonomyId && !!a.categoryId)
        : null;
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
      if (!name || !pattern || !categoryId) return refuse(UNDO_NOT_POSSIBLE);
      if (op === 'redo') {
        if (state.rule) return refuse('That rule is already there.');
        return plan({ op, needsSync: false, ruleAfter: 'created', done: 'Redone — the rule is back.', steps: [{ do: 'create-rule', rule: { name, pattern, categoryId } }] });
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
          : 'Undone — the rule is gone.',
      });
    }

    case 'mapping-rule-created': {
      const rule = mappingRuleOf(entry);
      if (!rule) return refuse(UNDO_NOT_POSSIBLE);
      const present = (state.mappingRules ?? []).some((r) => sameRule(r, rule));
      if (op === 'undo' && !present) return refuse('That transaction rule is already gone.');
      if (op === 'redo' && present) return refuse('That transaction rule is already there.');
      return plan({
        op, needsSync: true, done: op === 'undo' ? 'Undone — the rule is gone.' : 'Redone — the rule is back.',
        steps: [op === 'undo' ? { do: 'mapping-remove', rule } : { do: 'mapping-add', rule }],
      });
    }

    case 'transfer-link':
    case 'transfer-type': {
      const keys = entry.subject.txKeys ?? [];
      if (keys.length === 0) return refuse(UNDO_NO_KEY);
      const legs = Array.isArray(after.legs) ? (after.legs as unknown[]).map(rec) : [];
      const steps: UndoStep[] = keys.map((txKey, i) => (op === 'undo'
        ? { do: 'set-tx', txKey, flag: 'notTransfer', label: labelOf(entry, str(legs[i]?.accountName) ?? undefined) } as const
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
              accountId, sourceSystem: 'simplefin', activityType, date, symbol: `$CASH-${currency}`,
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
            accountId, sourceSystem: 'simplefin', activityType, date, symbol: `$CASH-${currency}`,
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
          write: { id: row.id, accountId: row.accountId, activityType: toType, activityDate: toDate, amount: Math.abs(toCents) / 100, currency, comment: row.comment },
        }],
        done: op === 'undo'
          ? "Undone — the starting balance is back as it was, so the account may no longer match the bank's balance."
          : 'Redone.',
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
      const payload = rec(before.activity);
      const write = (str(payload.accountId) && str(payload.activityType) && str(payload.activityDate) && typeof payload.comment === 'string')
        ? payload as unknown as ActivityWrite
        : null;
      // A copy an earlier undo put back is still there: keeping it is all that is left to do.
      const steps: UndoStep[] = [{ do: 'set-tx', txKey: key, flag: 'keepDuplicate', label: labelOf(entry) }];
      if (!state.row) {
        if (!write) return refuse(UNDO_NOT_POSSIBLE);
        steps.push({ do: 'create', write });
      }
      return plan({ op, steps, needsSync: false, rowAfter: state.row ? state.row.id : 'created', done: 'Undone — both copies stay.' });
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
      if (row?.linked) return refuse(UNDO_LINKED_REFUSAL);
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
      if (row.linked) return refuse(UNDO_LINKED_REFUSAL);
      if (!beforeNote || row.comment !== str(after.comment)) return refuse(undoChangedSince(op));
      return plan({
        op, needsSync: false, rowAfter: row.id, done: 'Undone — the label is off, and stays off.',
        steps: [
          { do: 'set-tx', txKey: key, flag: 'noAmazonLabel', label: labelOf(entry) },
          { do: 'update', write: { id: row.id, accountId: row.accountId, activityType: row.type, activityDate: row.date, amount: row.absCents / 100, currency, comment: beforeNote } },
        ],
      });
    }

    default:
      return refuse(UNDO_NOT_POSSIBLE);
  }
}
