/**
 * shared/change-view.ts
 *
 * How a change log is SHOWN, shared by `/changes` (companion/src/changes-menu.ts)
 * and the app's Change log card (src/components/ChangeLogCard.tsx), so the two
 * group, search, word and number things the same way. Pure.
 *
 * Every string returned here is RAW: Telegram escapes it at render and keeps
 * it outside any bold or italic; the app renders it as text.
 */
import { bankUpdateParts, changeDay, changeMoney, type ChangeEntry, type StoredTxState } from './change-entries.js';
import type { ChangeLogItem, ChangeLogRead } from './change-log.js';
import { localIsoDay } from './subscription-roster.js';

export type ChangeGroup = 'categories' | 'transfers' | 'corrections' | 'imports' | 'rules' | 'background';

export const CHANGE_GROUPS: readonly ChangeGroup[] = ['categories', 'transfers', 'corrections', 'imports', 'rules', 'background'];

export const CHANGE_GROUP_LABELS: Record<ChangeGroup, string> = {
  categories: 'Categories',
  transfers: 'Transfers',
  corrections: 'Corrections',
  imports: 'Imports',
  rules: 'Rules',
  background: 'Background',
};

const GROUP_OF: Record<string, ChangeGroup> = {
  'category-filed': 'categories',
  'opening-balance-filed': 'categories',
  'amazon-label': 'categories',
  'venmo-note': 'categories',
  'transfer-link': 'transfers',
  'transfer-type': 'transfers',
  'duplicate-removed': 'corrections',
  'transaction-removed': 'corrections',
  'starting-balance': 'corrections',
  'starting-balance-moved': 'corrections',
  'balance-correction': 'corrections',
  import: 'imports',
  'bank-update': 'imports',
  'pending-removed': 'imports',
  'category-rule-created': 'rules',
  'mapping-rule-created': 'rules',
  'account-created': 'rules',
  // A budget is a category's: found where its filings are.
  'budget-set': 'categories',
  bookkeeping: 'background',
};

/** A kind this build does not know (written by a newer one) still shows,
 *  under Corrections, rather than vanishing behind Background. */
export function changeGroupOf(kind: string): ChangeGroup {
  return GROUP_OF[kind] ?? 'corrections';
}

export const isBackground = (e: Pick<ChangeEntry, 'kind'>) => e.kind === 'bookkeeping';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The account(s) an entry touched: a transfer link names both legs. */
export function changeAccountNames(e: ChangeEntry): string[] {
  const names: string[] = [];
  if (e.account?.name) names.push(e.account.name);
  const legs = isRecord(e.after) && Array.isArray(e.after.legs) ? e.after.legs : [];
  for (const leg of legs) {
    const name = isRecord(leg) ? str(leg.accountName) : null;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function changeAccountText(e: ChangeEntry): string {
  return changeAccountNames(e).join(' → ');
}

export function changeAmountText(e: ChangeEntry): string {
  return e.subject.amountCents === undefined ? '' : changeMoney(e.subject.amountCents);
}

/** Who did it, in words. */
export function changeSourceText(e: Pick<ChangeEntry, 'writer' | 'actor'>): string {
  if (e.actor === 'you') return e.writer === 'companion' ? 'You, in Telegram' : 'You, in the app';
  return e.writer === 'companion' ? 'Automatic — the background sync' : 'Automatic — a sync in the app';
}

const categoryText = (side: unknown) => (isRecord(side) ? str(side.categoryName) : null) ?? 'No category';

function storedState(side: unknown): StoredTxState | null {
  if (!isRecord(side)) return null;
  const absCents = num(side.absCents);
  const date = str(side.date);
  const activityType = str(side.activityType);
  if (absCents === null || date === null || activityType === null || typeof side.pending !== 'boolean') return null;
  return { absCents, date, pending: side.pending, activityType, subtype: str(side.subtype) };
}

/** `before → after` in words, or null when the kind has nothing to compare. */
export function changeBeforeAfter(e: ChangeEntry): string | null {
  const before = e.before;
  const after = e.after;
  switch (e.kind) {
    case 'category-filed':
    case 'opening-balance-filed':
      return `${categoryText(before)} → ${categoryText(after)}`;
    case 'starting-balance-moved': {
      if (!isRecord(before) || !isRecord(after)) return null;
      const side = (s: Record<string, unknown>) => {
        const cents = num(s.amountCents);
        const date = str(s.date);
        return `${cents === null ? '?' : changeMoney(cents)} on ${date ? changeDay(date) : '?'}`;
      };
      return `${side(before)} → ${side(after)}`;
    }
    case 'bank-update': {
      const b = storedState(before);
      const a = storedState(after);
      if (!b || !a) return null;
      const parts = bankUpdateParts(b, a);
      return parts.length ? parts.join(', ') : null;
    }
    case 'amazon-label':
    case 'venmo-note': {
      const b = isRecord(before) ? str(before.comment) : null;
      const a = isRecord(after) ? str(after.comment) : null;
      return b !== null && a !== null ? `${b} → ${a}` : null;
    }
    case 'transfer-type': {
      if (!isRecord(after)) return null;
      const from = isRecord(before) ? str(before.activityType) : null;
      const to = str(after.activityType) ?? '?';
      return `${from ?? 'New'} → ${to}${after.inTransit === true ? ' (in transit)' : ''}`;
    }
    case 'budget-set': {
      const cents = isRecord(after) ? num(after.amountCents) : null;
      return cents === null ? null : `No budget → ${changeMoney(cents)} a month`;
    }
    default:
      return null;
  }
}

/** What `/changes <words>` and the card's search box look in: the bank
 *  text, the account(s), the categories and the rule words. */
export function changeSearchText(e: ChangeEntry): string {
  const parts = [
    e.subject.description, e.subject.categoryName, e.subject.rulePattern, ...changeAccountNames(e),
    isRecord(e.before) ? str(e.before.categoryName) : null,
    isRecord(e.after) ? str(e.after.categoryName) : null,
  ];
  return parts.filter((p): p is string => !!p).join(' ').toLowerCase();
}

/** Every word must appear. An empty query matches everything. */
export function matchesChangeSearch(e: ChangeEntry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = changeSearchText(e);
  return words.every((w) => hay.includes(w));
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);

/** The identity one entry carries for its subject(s), aligned by position:
 *  a transfer link lists both legs, out first, in `subject.txKeys`,
 *  `subject.activityIds` and `before.activityIds` alike. */
function entryIdentity(e: ChangeEntry) {
  const before = isRecord(e.before) ? e.before : {};
  const after = isRecord(e.after) ? e.after : {};
  return {
    keys: strings(e.subject.txKeys),
    ids: strings(e.subject.activityIds),
    beforeIds: strings(before.activityIds),
    afterIds: strings(after.activityIds),
    oldKey: e.kind === 'bank-update' ? str(before.txKey) : null,
    leftBehind: str(after.activityId),
  };
}

function entryMatches(e: ChangeEntry, keys: Set<string>, ids: Set<string>): boolean {
  const x = entryIdentity(e);
  return x.keys.some((k) => keys.has(k))
    || (x.oldKey !== null && keys.has(x.oldKey))
    || x.ids.some((id) => ids.has(id))
    || x.beforeIds.some((id) => ids.has(id));
}

/** What a matched entry teaches about the same transaction: a bank update's
 *  old key, the row a reversal left behind, and — for a link — THIS leg's old
 *  and new ids and key, found by its position. Bookkeeping lists rows that do
 *  not line up by position, so it teaches nothing. */
function learnIdentity(e: ChangeEntry, keys: Set<string>, ids: Set<string>): void {
  if (e.kind === 'bookkeeping') return;
  const x = entryIdentity(e);
  if (x.oldKey) keys.add(x.oldKey);
  if (x.keys.length <= 1 && x.ids.length <= 1) {
    for (const k of x.keys) keys.add(k);
    for (const id of [...x.ids, ...x.beforeIds, ...(x.leftBehind ? [x.leftBehind] : [])]) ids.add(id);
    return;
  }
  const legs = Math.max(x.keys.length, x.ids.length, x.beforeIds.length);
  for (let i = 0; i < legs; i++) {
    const mine = (x.keys[i] !== undefined && keys.has(x.keys[i]))
      || (x.ids[i] !== undefined && ids.has(x.ids[i]))
      || (x.beforeIds[i] !== undefined && ids.has(x.beforeIds[i]));
    if (!mine) continue;
    if (x.keys[i]) keys.add(x.keys[i]);
    for (const id of [x.ids[i], x.beforeIds[i], x.afterIds[i]]) if (id) ids.add(id);
  }
}

/**
 * Every entry about ONE transaction, oldest first — the story's "What
 * happened". It matches, in this order: the transaction's account-scoped tx
 * keys; the OLD key a bank update records when a pending row posted under a
 * new transaction id (so the posted row keeps its pending history); its
 * activity ids, current and the ones a transfer link replaced
 * (`subject.activityIds`, `before.activityIds`). Every match can teach more of
 * the same transaction's identity, so the walk repeats until nothing new is
 * learned. Background bookkeeping about the transaction is included.
 */
export function changesForTransaction<T extends ChangeEntry>(
  entries: readonly T[],
  id: { txKeys?: readonly string[]; activityIds?: readonly string[] },
): T[] {
  const keys = new Set((id.txKeys ?? []).filter(Boolean));
  const ids = new Set((id.activityIds ?? []).filter(Boolean));
  for (let pass = 0; pass < 8; pass++) {
    const known = keys.size + ids.size;
    for (const e of entries) if (entryMatches(e, keys, ids)) learnIdentity(e, keys, ids);
    if (keys.size + ids.size === known) break;
  }
  return entries
    .filter((e) => entryMatches(e, keys, ids))
    .sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.at < b.at ? -1 : 1));
}

/** Hops `currentActivityId` follows at most: a link, a later link of the
 *  same leg, a re-created row — and never round a loop. */
const FORWARD_MAX_HOPS = 8;

const newestFirst = <T extends Pick<ChangeEntry, 'at'>>(entries: readonly T[]) =>
  [...entries].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

/**
 * Where a row went: the activity id that stands for `activityId` now — the
 * forward half of `changesForTransaction`'s walk, for a button or a list that
 * carries an id the log has since replaced. Two things re-create a row:
 *  - a transfer link deletes both legs and writes them again, so each leg's
 *    old id `before.activityIds[i]` becomes `after.activityIds[i]`, by
 *    position. A link that was undone is not followed (its Undo re-imports the
 *    legs on the next sync, under ids no entry ties back), and neither is an
 *    Undo or Redo entry, whose before and after are the other way round;
 *  - an Undo or Redo that put a row back records it as `after.activityId`. The
 *    NEWEST reversal of an entry decides, from its row or any row an earlier
 *    reversal of it left behind; one that removed the row leads nowhere.
 * Repeats until nothing moves, at most FORWARD_MAX_HOPS times. The id itself
 * when nothing moved it.
 */
export function currentActivityId(entries: readonly ChangeLogItem[], activityId: string): string {
  const ordered = newestFirst(entries);
  const links = ordered.filter((e) => e.kind === 'transfer-link' && !e.reverses && !e.undone).map(entryIdentity);
  // Each reversed entry's reversals, newest first.
  const reversals = new Map<string, ChangeLogItem[]>();
  for (const e of ordered) if (e.reverses) reversals.set(e.reverses.id, [...(reversals.get(e.reverses.id) ?? []), e]);

  const next = (id: string): string | null => {
    for (const x of links) {
      const i = x.beforeIds.indexOf(id);
      if (i !== -1 && x.afterIds[i]) return x.afterIds[i];
    }
    for (const group of reversals.values()) {
      // The newest reversal kept the same row, or removed it: nothing moved.
      const to = entryIdentity(group[0]).leftBehind;
      if (!to || to === id) continue;
      if (group.some((r) => strings(r.subject.activityIds).includes(id) || entryIdentity(r).leftBehind === id)) return to;
    }
    return null;
  };

  let id = activityId;
  const seen = new Set([id]);
  for (let hop = 0; hop < FORWARD_MAX_HOPS; hop++) {
    const moved = next(id);
    if (!moved || seen.has(moved)) break;
    seen.add(moved);
    id = moved;
  }
  return id;
}

/** Entries from the last `days` days (by the moment they were written). */
export function changesWithin<T extends Pick<ChangeEntry, 'at'>>(entries: readonly T[], now: Date, days: number): T[] {
  const cutoff = now.getTime() - days * 86_400_000;
  return entries.filter((e) => Date.parse(e.at) >= cutoff);
}

/** The local calendar day an entry was written (the reader's zone). */
export function changeLocalDay(at: string): string {
  return localIsoDay(new Date(at));
}

/** `14:05`, local. */
export function changeClock(at: string): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export type ChangeRow =
  | { kind: 'entry'; entry: ChangeLogItem }
  | { kind: 'run'; run: string; entries: ChangeLogItem[] };

/**
 * Display rows, newest first: the imports of one sync run collapse into ONE
 * row ("Imported 4 transactions") at the place of the run's newest import.
 * A run with a single import stays an ordinary row.
 */
export function changeRows(entries: readonly ChangeLogItem[]): ChangeRow[] {
  const runImports = new Map<string, ChangeLogItem[]>();
  for (const e of entries) {
    if (e.kind !== 'import' || !e.run) continue;
    runImports.set(e.run, [...(runImports.get(e.run) ?? []), e]);
  }
  const rows: ChangeRow[] = [];
  const placed = new Set<string>();
  for (const e of entries) {
    const group = e.kind === 'import' && e.run ? runImports.get(e.run) : undefined;
    if (!group || group.length < 2) {
      rows.push({ kind: 'entry', entry: e });
      continue;
    }
    if (placed.has(e.run!)) continue;
    placed.add(e.run!);
    rows.push({ kind: 'run', run: e.run!, entries: group });
  }
  return rows;
}

export function changeRowAt(row: ChangeRow): string {
  return row.kind === 'entry' ? row.entry.at : row.entries[0].at;
}

export function changeRowSummary(row: ChangeRow): string {
  return row.kind === 'entry' ? row.entry.summary : `Imported ${row.entries.length} ${row.entries.length === 1 ? 'transaction' : 'transactions'}`;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[(m || 1) - 1]} ${y}`;
};
const writerLabel = (w: string) => (w === 'addon' ? "app's" : "companion's");

/** Part of the window is missing: a bucket can't be read, or a gap says
 *  changes were not saved (`readChangeLog` keeps only gaps inside the 90
 *  days). An absence in such a log proves nothing. */
export function isChangeLogPartial(read: Pick<ChangeLogRead, 'gaps' | 'unreadable'>): boolean {
  return read.unreadable.length > 0 || read.gaps.length > 0;
}

/** One sentence per gap, trim and unreadable bucket, for the top of the feed. */
export function changeLogNotes(read: Pick<ChangeLogRead, 'gaps' | 'trimmed' | 'unreadable'>): string[] {
  const notes: string[] = [];
  for (const g of read.gaps) {
    notes.push(`${g.count} ${g.count === 1 ? 'change' : 'changes'} may be missing — ${g.reason} ${changeDay(changeLocalDay(g.at))}.`);
  }
  if (read.trimmed > 0) {
    notes.push(`${read.trimmed} older ${read.trimmed === 1 ? 'change was' : 'changes were'} trimmed to keep the log small.`);
  }
  for (const u of read.unreadable) {
    notes.push(u.paused
      ? `The ${writerLabel(u.writer)} log for ${monthName(u.month)} can't be read, so its new changes aren't being saved.`
      : `Part of the ${writerLabel(u.writer)} log for ${monthName(u.month)} can't be read — it was left as it was.`);
  }
  return notes;
}
