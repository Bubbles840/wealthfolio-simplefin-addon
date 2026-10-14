/**
 * shared/change-entries.ts
 *
 * One entry per write the add-on or the companion made to the books: what the
 * change log (shared/change-log.ts) stores, what `/changes` and the app's
 * Change log card show, and what Undo (release R2) will reverse. Pure — no I/O.
 *
 * Every entry is built by ONE function per kind below, and that function also
 * writes the entry's plain-English `summary`, so Telegram and the app read the
 * same words. Bank and user text inside a summary is RAW: Telegram escapes it
 * when it renders, the app renders it as text.
 *
 * `before`/`after` already carry what R2's undo needs, so nothing R1 writes
 * needs a migration later:
 *  - a filing: the previous and new category id + name (and, for a move, every
 *    assignment the row held);
 *  - a balance correction: the row's activity id, account and signed amount;
 *  - a removed duplicate: the full create payload of the row that was deleted;
 *  - a starting balance: its amount, date and type before and after;
 *  - a category rule: its id, name, pattern and category;
 *  - an import: the activity id and the account-scoped tx key;
 *  - a transfer link: both legs' tx keys and their new activity ids;
 *  - an Amazon label: the label text and the note before and after;
 *  - a Venmo note: the note text and the row's note before and after;
 *  - a row you removed for good (2c R2): its tx keys and its full create payload.
 */

export type ChangeWriter = 'addon' | 'companion';
export type ChangeActor = 'auto' | 'you';

export type ChangeKind =
  | 'import' | 'bank-update' | 'pending-removed'
  | 'transfer-link' | 'transfer-type'
  | 'duplicate-removed' | 'transaction-removed'
  | 'starting-balance' | 'starting-balance-moved' | 'balance-correction'
  | 'amazon-label' | 'venmo-note' | 'category-filed' | 'opening-balance-filed'
  | 'category-rule-created' | 'mapping-rule-created'
  | 'account-created'
  | 'bookkeeping';

export const CHANGE_KINDS: readonly ChangeKind[] = [
  'import', 'bank-update', 'pending-removed',
  'transfer-link', 'transfer-type',
  'duplicate-removed', 'transaction-removed',
  'starting-balance', 'starting-balance-moved', 'balance-correction',
  'amazon-label', 'venmo-note', 'category-filed', 'opening-balance-filed',
  'category-rule-created', 'mapping-rule-created',
  'account-created',
  'bookkeeping',
];

export interface ChangeAccount { sfinId?: string; wfId?: string; name: string }

export interface ChangeSubject {
  /** `accountTxKey(sfinAccountId, txId)` — the identity that survives a re-link. */
  txKeys?: string[];
  activityIds?: string[];
  /** Bank text (`descriptionFromComment`), raw. */
  description?: string;
  /** Signed cents, money out negative. */
  amountCents?: number;
  /** YYYY-MM-DD. */
  date?: string;
  ruleId?: string;
  rulePattern?: string;
  categoryName?: string;
}

export interface ChangeEntry {
  /** `<a|c><base36 ms><base36 counter>`, unique per writer. */
  id: string;
  /** ISO timestamp of the write. */
  at: string;
  writer: ChangeWriter;
  /** An automatic decision, or a person's own Telegram/app action. */
  actor: ChangeActor;
  /** The sync run that wrote it; groups one run's entries. */
  run?: string;
  kind: ChangeKind;
  account?: ChangeAccount;
  subject: ChangeSubject;
  /** One plain-English line, built by this module. Raw text inside. */
  summary: string;
  /** Rule words, Amazon email label, keyword, "bank changed it". Raw. */
  why?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** False for bank-made changes and bookkeeping. */
  undoable: boolean;
  /** R2 only: an undo/redo entry points at the entry it reverses. */
  reverses?: { id: string; op: 'undo' | 'redo' };
}

/** What a builder returns: everything but the stamp (`stampChange` adds it). */
export type ChangeDraft = Omit<ChangeEntry, 'id' | 'at' | 'writer' | 'run'>;

/**
 * Where a sync run (and an after-sync step) sends its entries. `run` is the
 * run's id (`newRunId`), stamped on every entry of that run. `append` must
 * never reject — `createChangeLogWriter` keeps that promise — but every caller
 * still guards it, because a log must never cost the sync.
 */
export interface ChangeLogSink {
  writer: ChangeWriter;
  run: string;
  append(entries: ChangeEntry[]): Promise<void>;
}

const INITIAL: Record<ChangeWriter, string> = { addon: 'a', companion: 'c' };
/** Process-wide, so two stampers in one process (a sync and a Telegram tap in
 *  the same millisecond) can never mint the same id. */
let sequence = 0;

/** `<a|c><base36 ms>` — one per sync run. */
export function newRunId(writer: ChangeWriter, now: Date): string {
  return `${INITIAL[writer]}${now.getTime().toString(36)}`;
}

/** `<a|c><base36 ms><base36 counter>`. The millisecond part is a fixed 8
 *  characters until 2059, so the counter suffix can never make two ids equal. */
export function newEntryId(writer: ChangeWriter, now: Date): string {
  sequence += 1;
  return `${INITIAL[writer]}${now.getTime().toString(36)}${sequence.toString(36)}`;
}

export function stampChange(draft: ChangeDraft, writer: ChangeWriter, now: Date, run?: string): ChangeEntry {
  return { id: newEntryId(writer, now), at: now.toISOString(), writer, ...(run ? { run } : {}), ...draft };
}

/** `-$1,234.56` — always cents, ASCII minus. A log is a record, not a report. */
export function changeMoney(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${cents < 0 ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `2026-10-03` → `Oct 3`. Read as a calendar date, never shifted by a zone. */
export function changeDay(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${MONTHS[(m || 1) - 1]} ${d || 1}`;
}

/** `changeDay`, plus the year ("Oct 4, 2024") when it is not `now`'s year. */
export function changeDayYear(iso: string, now: Date): string {
  const year = Number(iso.slice(0, 4));
  return year && year !== now.getFullYear() ? `${changeDay(iso)}, ${year}` : changeDay(iso);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** The bank text a summary names; a blank description is legitimate. */
const what = (description: string | undefined) => (description && description.trim() ? description.trim() : 'a transaction');

// ── Bank feed ────────────────────────────────────────────────────────────

export interface ImportFacts {
  account: ChangeAccount;
  txKey: string;
  activityId: string;
  description: string;
  /** Signed, money out negative. */
  amountCents: number;
  date: string;
  pending: boolean;
  activityType: string;
}

/**
 * A bank transaction the sync created. Undo (R2): skip list + remove the row.
 * Size: the identity is stored ONCE. R2 reads the row id from
 * `subject.activityIds[0]` and the tx key from `subject.txKeys[0]`; `after`
 * holds only what the subject does not (type and pending state).
 */
export function importChange(f: ImportFacts): ChangeDraft {
  return {
    actor: 'auto',
    kind: 'import',
    account: f.account,
    subject: { txKeys: [f.txKey], activityIds: [f.activityId], description: f.description, amountCents: f.amountCents, date: f.date },
    summary: `Imported ${what(f.description)}${f.pending ? ' (pending)' : ''}`,
    after: { activityType: f.activityType, pending: f.pending },
    undoable: true,
  };
}

/** A stored row as the reconcile step compares it. `absCents` is the
 *  magnitude; the type carries the direction, as Wealthfolio stores it. */
export interface StoredTxState {
  absCents: number;
  date: string;
  pending: boolean;
  activityType: string;
  subtype?: string | null;
}

export interface BankUpdateFacts {
  account: ChangeAccount;
  txKey: string;
  activityId: string;
  description: string;
  /** Signed, after the update. */
  amountCents: number;
  before: StoredTxState;
  after: StoredTxState;
  /** The old tx key, when a pending row posted under a NEW tx id. */
  previousTxKey?: string;
}

/** What the bank changed, as short phrases: `$12.00 → $12.34`, `posted`. */
export function bankUpdateParts(before: StoredTxState, after: StoredTxState): string[] {
  const parts: string[] = [];
  if (before.absCents !== after.absCents) parts.push(`${changeMoney(before.absCents)} → ${changeMoney(after.absCents)}`);
  if (before.date !== after.date) parts.push(`${changeDay(before.date)} → ${changeDay(after.date)}`);
  if (before.pending && !after.pending) parts.push('posted');
  if (!before.pending && after.pending) parts.push('pending again');
  if (before.activityType !== after.activityType) parts.push(`${before.activityType} → ${after.activityType}`);
  const sub = (s: string | null | undefined) => (s ?? '').trim().toUpperCase();
  if (sub(after.subtype) && sub(before.subtype) !== sub(after.subtype)) parts.push(`marked ${sub(after.subtype)}`);
  return parts;
}

/**
 * A reconcile update. Mostly the bank's doing; when only the type and/or
 * subtype moved it is the sync's or a rule's decision, and says so. Not
 * undoable: the bank is the source of truth. R2 reads the row id and tx key
 * from `subject`; `before.txKey` is present only for a posting under a new id.
 */
export function bankUpdateChange(f: BankUpdateFacts): ChangeDraft {
  const parts = bankUpdateParts(f.before, f.after);
  const bankMoved = !!f.previousTxKey
    || f.before.absCents !== f.after.absCents
    || f.before.date !== f.after.date
    || f.before.pending !== f.after.pending;
  const retyped = f.before.activityType !== f.after.activityType;
  const [summary, why] = bankMoved
    ? [`Updated ${what(f.description)} from the bank${parts.length ? `: ${parts.join(', ')}` : ''}`, 'The bank changed it']
    : retyped
      ? [`Retyped ${what(f.description)}: ${parts.join(', ')}`, 'The sync retyped it']
      : [`${what(f.description)} ${parts.length ? parts.join(', ') : 'updated'}`, 'A rule changed it'];
  return {
    actor: 'auto',
    kind: 'bank-update',
    account: f.account,
    subject: { txKeys: [f.txKey], activityIds: [f.activityId], description: f.description, amountCents: f.amountCents, date: f.after.date },
    summary,
    why,
    before: { ...f.before, ...(f.previousTxKey ? { txKey: f.previousTxKey } : {}) },
    after: { ...f.after },
    undoable: false,
  };
}

export interface PendingRemovedFacts {
  account: ChangeAccount;
  txKey: string;
  activityId: string;
  description: string;
  amountCents: number;
  date: string;
}

export function pendingRemovedChange(f: PendingRemovedFacts): ChangeDraft {
  return {
    actor: 'auto',
    kind: 'pending-removed',
    account: f.account,
    subject: { txKeys: [f.txKey], activityIds: [f.activityId], description: f.description, amountCents: f.amountCents, date: f.date },
    summary: `Removed pending ${what(f.description)} — the bank dropped it`,
    why: 'The bank dropped a pending transaction',
    before: { activityId: f.activityId, txKey: f.txKey, amountCents: f.amountCents, date: f.date },
    undoable: false,
  };
}

// ── Transfers ────────────────────────────────────────────────────────────

export interface TransferTypeFacts {
  account: ChangeAccount;
  txKey: string;
  activityId: string;
  description: string;
  amountCents: number;
  date: string;
  /** The type it now has. */
  activityType: string;
  /** The type it had, or null for a row created as a placeholder. */
  previousType: string | null;
  /** true: held as a transfer in transit. false: the wait ran out. */
  held: boolean;
  /** With `held: false`: retyped because the person undid the transfer
   *  decision (a `notTransfer` override), not because the wait ran out. */
  undone?: boolean;
}

/**
 * The sync typing ONE leg as a transfer without a partner (held), or giving
 * up on one. Holding is undoable in R2 (`notTransfer` on this leg); giving up
 * is not — there is no "it is a transfer after all" override.
 */
export function transferTypeChange(f: TransferTypeFacts): ChangeDraft {
  return {
    actor: 'auto',
    kind: 'transfer-type',
    account: f.account,
    subject: { txKeys: [f.txKey], activityIds: [f.activityId], description: f.description, amountCents: f.amountCents, date: f.date },
    summary: f.held
      ? `Held ${what(f.description)} as a transfer in transit`
      : f.undone
        ? `Counted ${what(f.description)} as ${f.amountCents < 0 ? 'spending' : 'money in'} — you said it isn't a transfer`
        : `Stopped waiting for the other half of ${what(f.description)} — now counted as ${f.amountCents < 0 ? 'spending' : 'money in'}`,
    why: f.held ? 'Looks like a transfer; waiting for the other half' : f.undone ? 'You undid the transfer' : 'No other half arrived within 10 days',
    before: { activityType: f.previousType, inTransit: !f.held },
    after: { activityType: f.activityType, inTransit: f.held },
    undoable: f.held,
  };
}

export interface LinkLegFacts {
  account: ChangeAccount;
  txKey: string;
  description: string;
  amountCents: number;
  date: string;
  /** The row before linking (linking deletes and re-creates it). */
  oldActivityId: string;
  /** The re-created row, when the host reports it. */
  newActivityId?: string;
}

/** Two legs linked as one transfer — by the sync, or by you from the Health
 *  list (2c R2). Undo (R2): `notTransfer` on both tx keys. */
export function transferLinkChange(out: LinkLegFacts, inLeg: LinkLegFacts, actor: ChangeActor = 'auto'): ChangeDraft {
  const fresh = [out.newActivityId, inLeg.newActivityId].filter((id): id is string => !!id);
  const leg = (l: LinkLegFacts) => ({
    txKey: l.txKey,
    accountName: l.account.name,
    description: l.description,
    ...(l.account.wfId ? { wfAccountId: l.account.wfId } : {}),
    ...(l.account.sfinId ? { sfinAccountId: l.account.sfinId } : {}),
    ...(l.newActivityId ? { activityId: l.newActivityId } : {}),
  });
  return {
    actor,
    kind: 'transfer-link',
    account: out.account,
    subject: {
      txKeys: [out.txKey, inLeg.txKey],
      ...(fresh.length === 2 ? { activityIds: fresh } : {}),
      description: out.description,
      amountCents: out.amountCents,
      date: out.date,
    },
    summary: `Linked ${what(out.description)} and ${what(inLeg.description)} as one transfer`,
    why: actor === 'you' ? 'You linked them from the Health list' : 'Same amount left one account and arrived in another',
    before: { activityIds: [out.oldActivityId, inLeg.oldActivityId] },
    after: { ...(fresh.length === 2 ? { activityIds: fresh } : {}), legs: [leg(out), leg(inLeg)] },
    undoable: true,
  };
}

// ── Corrections ──────────────────────────────────────────────────────────

export interface DuplicateRemovedFacts {
  account: ChangeAccount;
  txKey: string;
  activityId: string;
  description: string;
  amountCents: number;
  date: string;
  /** The deleted row as a create request (`ActivityWrite` shape). */
  payload: Record<string, unknown>;
}

export function duplicateRemovedChange(f: DuplicateRemovedFacts): ChangeDraft {
  return {
    actor: 'auto',
    kind: 'duplicate-removed',
    account: f.account,
    subject: { txKeys: [f.txKey], activityIds: [f.activityId], description: f.description, amountCents: f.amountCents, date: f.date },
    summary: `Removed a duplicate copy of ${what(f.description)}`,
    why: 'Wealthfolio held this transaction twice',
    before: { activityId: f.activityId, activity: f.payload },
    undoable: true,
  };
}

export interface TransactionRemovedFacts {
  account: ChangeAccount;
  /** Its key under every feed of its account: each went on the skip list. */
  txKeys: string[];
  activityId: string;
  description: string;
  /** Signed, money out negative. */
  amountCents: number;
  date: string;
  /** The deleted row as a create request (`ActivityWrite` shape). */
  payload: Record<string, unknown>;
  /** The keys this removal itself put on the skip list (not ones skipped earlier); Undo takes back only these. */
  addedKeys?: string[];
}

/**
 * A row you removed for good (2c R2, "Remove for good…" on its story): deleted,
 * and its tx id put on the skip list so the bank feed never imports it again.
 * Undo (R2): re-create the row from `before.activity`, then take it off the
 * skip list. Redo: skip it and remove it again.
 */
export function transactionRemovedChange(f: TransactionRemovedFacts): ChangeDraft {
  return {
    actor: 'you',
    kind: 'transaction-removed',
    account: f.account,
    subject: { txKeys: [...f.txKeys], activityIds: [f.activityId], description: f.description, amountCents: f.amountCents, date: f.date },
    summary: `Removed ${what(f.description)} for good`,
    why: "You removed it; the bank feed won't import it again",
    before: { activityId: f.activityId, activity: f.payload, ...(f.addedKeys ? { addedKeys: f.addedKeys } : {}) },
    undoable: true,
  };
}

export interface BalanceRowFacts {
  account: ChangeAccount;
  /** Absent when the host could not report the new row's id. */
  activityId?: string;
  /** Signed. */
  amountCents: number;
  date: string;
  activityType: string;
  /** The row's note, which also finds it without the id. */
  comment: string;
}

/** The one-time opening balance the sync wrote. Undo (R2): remove the row. */
export function startingBalanceChange(f: BalanceRowFacts): ChangeDraft {
  return {
    actor: 'auto',
    kind: 'starting-balance',
    account: f.account,
    subject: { ...(f.activityId ? { activityIds: [f.activityId] } : {}), amountCents: f.amountCents, date: f.date },
    summary: `Set the starting balance, dated ${changeDay(f.date)}`,
    why: "Everything before the first sync, so the account matches the bank's balance",
    after: {
      ...(f.activityId ? { activityId: f.activityId } : {}),
      amountCents: f.amountCents, date: f.date, activityType: f.activityType, comment: f.comment,
    },
    undoable: true,
  };
}

export interface BaselineState { amountCents: number; date: string; activityType: string }

export interface StartingBalanceMovedFacts {
  account: ChangeAccount;
  actor: ChangeActor;
  activityId: string;
  before: BaselineState;
  after: BaselineState;
}

/** The starting balance changed in place — moved in front of older history by
 *  the sync, or corrected by the person accepting the baseline fix. */
export function startingBalanceMovedChange(f: StartingBalanceMovedFacts): ChangeDraft {
  const sameAmount = f.before.amountCents === f.after.amountCents;
  const sameDate = f.before.date === f.after.date;
  const summary = sameAmount
    ? `Moved the starting balance to ${changeDay(f.after.date)} (was ${changeDay(f.before.date)})`
    : sameDate
      ? `Changed the starting balance (was ${changeMoney(f.before.amountCents)})`
      : `Changed the starting balance and moved it to ${changeDay(f.after.date)} (was ${changeMoney(f.before.amountCents)} on ${changeDay(f.before.date)})`;
  return {
    actor: f.actor,
    kind: 'starting-balance-moved',
    account: f.account,
    subject: { activityIds: [f.activityId], amountCents: f.after.amountCents, date: f.after.date },
    summary,
    why: f.actor === 'you' ? 'You accepted the starting-balance fix' : 'Older transactions arrived from the bank',
    before: { activityId: f.activityId, ...f.before },
    after: { activityId: f.activityId, ...f.after },
    undoable: true,
  };
}

export interface BalanceCorrectionFacts extends BalanceRowFacts { actor: ChangeActor }

/** A `Balance adjustment` row: the aggressive re-scan's plug, or the Add
 *  adjustment button. Undo (R2): remove the row, `noAutoCorrect`. */
export function balanceCorrectionChange(f: BalanceCorrectionFacts): ChangeDraft {
  return {
    actor: f.actor,
    kind: 'balance-correction',
    account: f.account,
    subject: { ...(f.activityId ? { activityIds: [f.activityId] } : {}), amountCents: f.amountCents, date: f.date },
    summary: 'Added a balance correction',
    ...(f.actor === 'auto' ? { why: "Aggressive auto re-scan: the account didn't match the bank" } : {}),
    after: {
      ...(f.activityId ? { activityId: f.activityId } : {}),
      accountId: f.account.wfId ?? null,
      amountCents: f.amountCents, date: f.date, activityType: f.activityType, comment: f.comment,
    },
    undoable: true,
  };
}

// ── Categories ───────────────────────────────────────────────────────────

export interface FiledCategory { categoryId: string; categoryName: string; taxonomyId?: string }

export interface AmazonLabelFacts {
  account: ChangeAccount;
  txKey: string;
  activityId: string;
  /** The bank's own text, without the label. */
  description: string;
  amountCents: number;
  date: string;
  beforeNote: string;
  afterNote: string;
  label: string;
}

/** The label `amazonDescription` adds: the text after ` · Amazon: `. */
export function amazonLabelOf(bare: string, enriched: string): string {
  const head = `${bare} · Amazon: `;
  return enriched.startsWith(head) ? enriched.slice(head.length) : enriched;
}

/** A late Amazon label added to a note. Undo (R2): put the old note back, `noAmazonLabel`. */
export function amazonLabelChange(f: AmazonLabelFacts): ChangeDraft {
  return {
    actor: 'auto',
    kind: 'amazon-label',
    account: f.account,
    subject: { txKeys: [f.txKey], activityIds: [f.activityId], description: f.description, amountCents: f.amountCents, date: f.date },
    summary: `Added the Amazon label "${f.label}" to ${what(f.description)}`,
    why: 'Amazon order email',
    before: { comment: f.beforeNote },
    after: { comment: f.afterNote, label: f.label },
    undoable: true,
  };
}

export interface VenmoNoteFacts {
  account: ChangeAccount;
  txKey: string;
  activityId: string;
  /** The bank's own text, without the note. */
  description: string;
  amountCents: number;
  date: string;
  beforeNote: string;
  afterNote: string;
  /** The text after ` · Venmo: `. */
  note: string;
}

/** A Venmo note added to a row's note, at import or later (3). A sync decision:
 *  Undo puts the old note back and sets `noVenmoNote`. */
export function venmoNoteChange(f: VenmoNoteFacts): ChangeDraft {
  return {
    actor: 'auto',
    kind: 'venmo-note',
    account: f.account,
    subject: { txKeys: [f.txKey], activityIds: [f.activityId], description: f.description, amountCents: f.amountCents, date: f.date },
    summary: `Added the Venmo note "${f.note}" to ${what(f.description)}`,
    why: 'Venmo email',
    before: { comment: f.beforeNote },
    after: { comment: f.afterNote, note: f.note },
    undoable: true,
  };
}

export interface CategoryFiledFacts {
  actor: ChangeActor;
  account?: ChangeAccount;
  txKey?: string;
  activityId: string;
  description: string;
  amountCents?: number;
  date?: string;
  before: FiledCategory | null;
  after: FiledCategory | null;
  why?: string;
  /** A move's complete prior state: every taxonomy's assignment. */
  restore?: ReadonlyArray<{ taxonomyId: string; categoryId: string }>;
}

const filed = (c: FiledCategory | null) => (c
  ? { categoryId: c.categoryId, categoryName: c.categoryName, ...(c.taxonomyId ? { taxonomyId: c.taxonomyId } : {}) }
  : { categoryId: null, categoryName: null });

/** A category put on, moved, or taken off one transaction. Undo (R2): restore `before`. */
export function categoryFiledChange(f: CategoryFiledFacts): ChangeDraft {
  const desc = what(f.description);
  const summary = f.before && f.after
    ? `Moved ${desc} from ${f.before.categoryName} to ${f.after.categoryName}`
    : f.after
      ? `Filed ${desc} under ${f.after.categoryName}`
      : `Took ${desc} out of ${f.before?.categoryName ?? 'its category'}`;
  const categoryName = f.after?.categoryName ?? f.before?.categoryName;
  return {
    actor: f.actor,
    kind: 'category-filed',
    ...(f.account ? { account: f.account } : {}),
    subject: {
      ...(f.txKey ? { txKeys: [f.txKey] } : {}),
      activityIds: [f.activityId],
      description: f.description,
      ...(f.amountCents !== undefined ? { amountCents: f.amountCents } : {}),
      ...(f.date ? { date: f.date } : {}),
      ...(categoryName ? { categoryName } : {}),
    },
    summary,
    ...(f.why ? { why: f.why } : {}),
    before: { ...filed(f.before), ...(f.restore ? { assignments: f.restore.map((a) => ({ taxonomyId: a.taxonomyId, categoryId: a.categoryId })) } : {}) },
    after: filed(f.after),
    undoable: true,
  };
}

export interface OpeningBalanceFiledFacts {
  account: ChangeAccount;
  activityId: string;
  amountCents: number;
  date: string;
  category: FiledCategory;
}

export function openingBalanceFiledChange(f: OpeningBalanceFiledFacts): ChangeDraft {
  return {
    actor: 'auto',
    kind: 'opening-balance-filed',
    account: f.account,
    subject: { activityIds: [f.activityId], amountCents: f.amountCents, date: f.date, categoryName: f.category.categoryName },
    summary: `Filed the opening balance under ${f.category.categoryName}`,
    why: "A card's opening debt is not a purchase",
    before: filed(null),
    after: filed(f.category),
    undoable: true,
  };
}

// ── Rules and accounts ───────────────────────────────────────────────────

export interface CategoryRuleFacts {
  /** Null when the server's reply carried no id (find it by name in R2). */
  ruleId: string | null;
  name: string;
  pattern: string;
  categoryId: string;
  categoryName: string;
  /** The one account the rule is scoped to (3, L5); absent, every account. */
  account?: { wfId: string; name: string };
}

/** A Wealthfolio categorization rule created from Telegram. Undo (R2): delete it.
 *  A scoped one names its account, and its Redo re-creates it scoped. */
export function categoryRuleCreatedChange(f: CategoryRuleFacts): ChangeDraft {
  const where = f.account ? ` in ${f.account.name}` : '';
  return {
    actor: 'you',
    kind: 'category-rule-created',
    ...(f.account ? { account: { wfId: f.account.wfId, name: f.account.name } } : {}),
    subject: { ...(f.ruleId ? { ruleId: f.ruleId } : {}), rulePattern: f.pattern, categoryName: f.categoryName },
    summary: `Created a rule: descriptions containing "${f.pattern}"${where} go to ${f.categoryName}`,
    after: {
      ruleId: f.ruleId, name: f.name, pattern: f.pattern, categoryId: f.categoryId, categoryName: f.categoryName,
      ...(f.account ? { accountId: f.account.wfId } : {}),
    },
    undoable: true,
  };
}

export interface MappingRuleFacts {
  rule: { pattern: string; matchType: string; activityType: string; subtype?: string };
  /** The transaction it was taught from. */
  description?: string;
  account?: ChangeAccount;
}

/** A transaction rule added to `mapping_rules` (the transfer-learning menu). */
export function mappingRuleCreatedChange(f: MappingRuleFacts): ChangeDraft {
  const direction = f.rule.activityType === 'TRANSFER_IN' ? 'a transfer in'
    : f.rule.activityType === 'TRANSFER_OUT' ? 'a transfer out'
      : f.rule.activityType;
  return {
    actor: 'you',
    kind: 'mapping-rule-created',
    ...(f.account ? { account: f.account } : {}),
    subject: { rulePattern: f.rule.pattern, ...(f.description ? { description: f.description } : {}) },
    summary: `Added a transaction rule: "${f.rule.pattern}" is ${direction}`,
    after: { rule: { ...f.rule } },
    undoable: true,
  };
}

export interface AccountCreatedFacts { sfinId: string; wfId: string; name: string; accountType: string }

export function accountCreatedChange(f: AccountCreatedFacts): ChangeDraft {
  return {
    actor: 'you',
    kind: 'account-created',
    account: { sfinId: f.sfinId, wfId: f.wfId, name: f.name },
    subject: {},
    summary: 'Created a Wealthfolio account',
    after: { wfAccountId: f.wfId, sfinAccountId: f.sfinId, accountType: f.accountType },
    undoable: false,
  };
}

// ── Bookkeeping ──────────────────────────────────────────────────────────

export type BookkeepingStep = 'legacy-placeholder' | 'external-marker' | 'transfer-relink' | 'opening-category' | 'transfer-unlink';

export interface BookkeepingFacts {
  step: BookkeepingStep;
  account?: ChangeAccount;
  activityIds: string[];
  /** `opening-category` only: the category it created or reused. */
  categoryName?: string;
  /** `transfer-unlink`: the legs that were unlinked; `transfer-relink` from a
   *  Link (2c): the legs that were re-created. */
  legs?: Array<{ txKey: string; description: string }>;
  /** `transfer-unlink` only: how many pairs this entry covers (default 1) and
   *  how many rows were re-created (default: the ids listed). */
  pairs?: number;
  rows?: number;
}

/** Repairs the sync makes to its own rows. Shown behind a button; never undoable. */
export function bookkeepingChange(f: BookkeepingFacts): ChangeDraft {
  const n = f.activityIds.length;
  const summary = f.step === 'legacy-placeholder'
    ? `Restated ${n} old placeholder ${plural(n, 'row', 'rows')} with ${plural(n, 'its', 'their')} real ${plural(n, 'amount', 'amounts')}`
    : f.step === 'external-marker'
      ? `Marked ${n} bookkeeping ${plural(n, 'row', 'rows')} as outside transfers for Wealthfolio's Health page`
      : f.step === 'transfer-relink'
        ? `Re-created ${n} old transfer ${plural(n, 'row', 'rows')} so ${plural(n, 'it moves', 'they move')} cash`
        : f.step === 'transfer-unlink'
          ? ((f.pairs ?? 1) > 1
            ? `Unlinked ${f.pairs} transfers you undid: re-created their ${f.rows ?? n} rows as spending or money in`
            : `Unlinked a transfer you undid: re-created ${(f.rows ?? n) === 1 ? 'its row' : `its ${f.rows ?? n} rows`} as spending or money in`)
          : `Set up the "${f.categoryName ?? 'Opening balances'}" category and kept it out of spending`;
  return {
    actor: 'auto',
    kind: 'bookkeeping',
    ...(f.account ? { account: f.account } : {}),
    subject: {
      ...(n > 0 ? { activityIds: [...f.activityIds] } : {}),
      ...(f.legs?.length ? { txKeys: f.legs.map((l) => l.txKey), description: f.legs.map((l) => l.description).join(' / ') } : {}),
    },
    summary,
    after: { step: f.step, count: n, ...(f.categoryName ? { categoryName: f.categoryName } : {}) },
    undoable: false,
  };
}

// ── Undo and Redo (R2) ───────────────────────────────────────────────────

/**
 * The entry an Undo or a Redo writes, in the undoer's own bucket. Same kind,
 * account and subject as the entry it reverses (so it files under the same
 * filter), `reverses` pointing back at it, and `before`/`after` the other way
 * round for an undo. `extra` lands on `after`: the row or rule id the reversal
 * left behind (`activityId`, `ruleId`), which the next undo or redo of the same
 * entry acts on — a re-created row has a new id. Never itself undoable: you
 * undo or redo the original.
 */
export function reversalChange(
  original: ChangeEntry,
  op: 'undo' | 'redo',
  extra: Record<string, unknown> = {},
): ChangeDraft {
  const [before, after] = op === 'undo' ? [original.after, original.before] : [original.before, original.after];
  return {
    actor: 'you',
    kind: original.kind,
    ...(original.account ? { account: { ...original.account } } : {}),
    subject: { ...original.subject },
    summary: `${op === 'undo' ? 'Undid' : 'Redid'}: ${original.summary}`,
    ...(before ? { before: { ...before } } : {}),
    after: { ...(after ?? {}), ...extra },
    undoable: false,
    reverses: { id: original.id, op },
  };
}
