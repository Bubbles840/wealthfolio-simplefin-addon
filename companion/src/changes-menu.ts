/**
 * companion/src/changes-menu.ts
 *
 * `/changes`: the change log in Telegram, read-only in R1 — the last 7 days
 * newest first, grouped by day, 8 rows a page; one sync run's imports as one
 * row that opens them; bookkeeping behind a button; one screen per entry.
 * `/changes <words>` searches the whole log (90 days).
 *
 * STATELESS, like subscriptions-menu.ts. Every tap re-reads the log, and every
 * button carries where it leads: a view (`l`/`b` list, `s` search, `r` run) and
 * an entry's or a run's handle (`findingHandle`, 8 hex). Nothing is remembered
 * between a message and its tap, so a button still works after a restart, and
 * one whose entry has gone answers "That one is already sorted — refreshing."
 *
 * Bank and user text (a summary, an account name, a search) is escaped AND
 * kept outside every `*…*`/`_…_`: legacy Markdown ignores a backslash inside
 * an entity, and one bank `*` would cost the whole message.
 *
 * R2: an entry's screen offers `↩ Undo` or `Redo` (a rule: `↩ Undo rule` and
 * `↩ Undo rule + un-file N`). The tap runs the shared runner
 * (shared/change-undo-run.ts) — no confirmation — and the screen says what
 * happened; after a sync decision it adds `🔄 Sync now`, the same forced run
 * as `/sync`.
 */
import { MENU_CALLBACK_PREFIX } from '../../shared/categorize-menu.js';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log.js';
import { changeDay } from '../../shared/change-entries.js';
import {
  changeAccountText, changeAmountText, changeBeforeAfter, changeClock, changeLocalDay, changeLogNotes, changeRowAt,
  changeRows, changeRowSummary, changeSourceText, changesWithin, isBackground, matchesChangeSearch, type ChangeRow,
} from '../../shared/change-view.js';
import { findingHandle } from '../../shared/handle.js';
import { escapeMarkdown, shortDateTime, WHY_CALLBACK_PREFIX, type InlineKeyboard } from '../../shared/telegram.js';
import { undoAvailability, UNDO_TAKES_EFFECT, type UndoOp, type UndoVariant } from '../../shared/change-undo.js';
import type { UndoOutcome } from '../../shared/change-undo-run.js';

export const CHANGES_CALLBACK_PREFIX = `${MENU_CALLBACK_PREFIX}cl:`;
export const CHANGES_PAGE_SIZE = 8;
export const CHANGES_LIST_DAYS = 7;
/** A search rides inside every button of its screens, so it is cut to fit 64 bytes. */
export const CHANGES_QUERY_MAX_BYTES = 30;
export const CHANGES_GONE_ANSWER = 'That one is already sorted — refreshing.';
export const CHANGES_UNREACHABLE_REPLY = "Couldn't reach Wealthfolio — try again.";
export const CHANGES_SYNC_STARTED = 'Syncing…';
export const CHANGES_SYNC_RUNNING = 'Already syncing — hang on.';
const FAILED_ANSWER = 'Could not do that — check the companion logs.';

type Button = { text: string; callback_data: string };
export interface MenuScreen { text: string; keyboard: InlineKeyboard }

/** Where a screen is, and so where a button leads. */
export type ChangesView =
  | { kind: 'list'; page: number; background: boolean }
  | { kind: 'search'; page: number; query: string }
  | { kind: 'run'; run: string; page: number; from: { page: number; background: boolean } }
  | { kind: 'detail'; entry: string; back: Exclude<ChangesView, { kind: 'detail' | 'act' }> }
  /** A button on an entry's screen: `u` undo, `r` redo, `f` undo rule + un-file, `s` sync now. */
  | { kind: 'act'; action: ChangeAction; entry: string; back: Exclude<ChangesView, { kind: 'detail' | 'act' }> }
  /** 1.61: an entry opened from a `/why` story. Only ever a `back`: the entry's
   *  ‹ Back returns to that story, in place (`cz:wy:t<id>:c`, why-menu.ts).
   *  `cz:cl:d<handle>:w<36-char id>` is 53 bytes. */
  | { kind: 'why'; activityId: string };

export type ChangeAction = 'u' | 'r' | 'f' | 's';

const encodeList = (page: number, background: boolean) => `${background ? 'b' : 'l'}${page}`;

/** The `callback_data` for a view. */
export function changesData(view: ChangesView): string {
  return `${CHANGES_CALLBACK_PREFIX}${encodeView(view)}`;
}

function encodeView(view: ChangesView): string {
  switch (view.kind) {
    case 'list': return encodeList(view.page, view.background);
    case 'search': return `s${view.page}:${view.query}`;
    case 'run': return `r${view.page}:${view.run}:${encodeList(view.from.page, view.from.background)}`;
    case 'detail': return `d${view.entry}:${encodeView(view.back)}`;
    case 'act': return `x${view.action}${view.entry}:${encodeView(view.back)}`;
    case 'why': return `w${view.activityId}`;
  }
}

/** The view a button carries, or null for anything this menu never emitted. */
export function parseChangesData(data: string): ChangesView | null {
  if (!data.startsWith(CHANGES_CALLBACK_PREFIX)) return null;
  return decodeView(data.slice(CHANGES_CALLBACK_PREFIX.length), true);
}

function decodeView(s: string, allowDetail: boolean): ChangesView | null {
  let m = /^([lb])(\d{1,3})$/.exec(s);
  if (m) return { kind: 'list', page: Number(m[2]), background: m[1] === 'b' };
  m = /^s(\d{1,3}):(.+)$/s.exec(s);
  if (m) return { kind: 'search', page: Number(m[1]), query: m[2] };
  m = /^r(\d{1,3}):([0-9a-f]{8}):([lb])(\d{1,3})$/.exec(s);
  if (m) return { kind: 'run', page: Number(m[1]), run: m[2], from: { page: Number(m[4]), background: m[3] === 'b' } };
  m = /^w([^:\s]{1,64})$/.exec(s);
  if (m) return allowDetail ? null : { kind: 'why', activityId: m[1] };
  m = /^d([0-9a-f]{8}):(.+)$/s.exec(s);
  if (m && allowDetail) {
    const back = decodeView(m[2], false);
    return back && back.kind !== 'detail' && back.kind !== 'act' ? { kind: 'detail', entry: m[1], back } : null;
  }
  m = /^x([urfs])([0-9a-f]{8}):(.+)$/s.exec(s);
  if (m && allowDetail) {
    const back = decodeView(m[3], false);
    return back && back.kind !== 'detail' && back.kind !== 'act'
      ? { kind: 'act', action: m[1] as ChangeAction, entry: m[2], back }
      : null;
  }
  return null;
}

/** A search as it is kept: words, single-spaced, cut at a character to fit. */
export function normalizeChangesQuery(raw: string): string {
  let q = raw.trim().replace(/\s+/g, ' ');
  while (Buffer.byteLength(q, 'utf8') > CHANGES_QUERY_MAX_BYTES) q = Array.from(q).slice(0, -1).join('');
  return q.trim();
}

const runHandle = (run: string) => findingHandle(`run:${run}`);

/** One numbered line: `3. 14:05 · <summary> · -$12.34 · Checking`. */
function rowLine(n: number, row: ChangeRow): string {
  const at = changeRowAt(row);
  const tail = row.kind === 'entry'
    ? [changeAmountText(row.entry), changeAccountText(row.entry)].filter(Boolean).map(escapeMarkdown)
    : [];
  const undone = row.kind === 'entry' && row.entry.undone ? ' ↩' : '';
  return `${n}. ${changeClock(at)} · ${[escapeMarkdown(changeRowSummary(row)), ...tail].join(' · ')}${undone}`;
}

/** Day headings (`_Oct 12_`, fixed text) between numbered lines. */
function dayGrouped(rows: ChangeRow[], first: number): string[] {
  const lines: string[] = [];
  let day = '';
  rows.forEach((row, i) => {
    const d = changeLocalDay(changeRowAt(row));
    if (d !== day) {
      day = d;
      lines.push(`_${changeDay(d)}_`);
    }
    lines.push(rowLine(first + i + 1, row));
  });
  return lines;
}

function pageOf<T>(items: T[], page: number): { slice: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / CHANGES_PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { slice: items.slice(p * CHANGES_PAGE_SIZE, (p + 1) * CHANGES_PAGE_SIZE), page: p, pages };
}

/** Number buttons, four to a row, each opening its line. */
function numberRows(rows: ChangeRow[], first: number, back: Exclude<ChangesView, { kind: 'detail' | 'act' }>): Button[][] {
  const buttons = rows.map((row, i): Button => ({
    text: String(first + i + 1),
    callback_data: row.kind === 'run' && back.kind === 'list'
      ? changesData({ kind: 'run', run: runHandle(row.run), page: 0, from: { page: back.page, background: back.background } })
      : changesData({ kind: 'detail', entry: findingHandle(row.kind === 'entry' ? row.entry.id : row.entries[0].id), back }),
  }));
  const out: Button[][] = [];
  for (let i = 0; i < buttons.length; i += 4) out.push(buttons.slice(i, i + 4));
  return out;
}

function navRow(page: number, pages: number, at: (page: number) => string): Button[] {
  const nav: Button[] = [];
  if (page < pages - 1) nav.push({ text: '‹ Older', callback_data: at(page + 1) });
  if (page > 0) nav.push({ text: 'Newer ›', callback_data: at(page - 1) });
  return nav;
}

const MAX_NOTES = 3;
/** At most three notes (a long run of gap records must not push the message past
 *  Telegram's 4096-character limit), then a pointer to the app. */
function noteLines(read: ChangeLogRead): string[] {
  const notes = changeLogNotes(read);
  const lines = notes.slice(0, MAX_NOTES).map((n) => `⚠️ ${escapeMarkdown(n)}`);
  const more = notes.length - MAX_NOTES;
  if (more > 0) lines.push(`⚠️ and ${more} more ${more === 1 ? 'note' : 'notes'} — see the app's Change log.`);
  return lines;
}

/** The list: the last 7 days, background hidden unless asked for. */
export function renderChangesList(read: ChangeLogRead, page: number, background: boolean, now: Date): MenuScreen {
  const recent = changesWithin(read.entries, now, CHANGES_LIST_DAYS);
  const hidden = recent.filter(isBackground).length;
  const rows = changeRows(background ? recent : recent.filter((e) => !isBackground(e)));
  const { slice, page: p, pages } = pageOf(rows, page);
  const first = p * CHANGES_PAGE_SIZE;
  const lines = [`*Changes — last ${CHANGES_LIST_DAYS} days*`, ...(p === 0 ? noteLines(read) : [])];
  if (rows.length === 0) lines.push('', `Nothing changed in the last ${CHANGES_LIST_DAYS} days.`);
  else lines.push('', ...dayGrouped(slice, first));
  if (pages > 1) lines.push('', `Page ${p + 1} of ${pages}`);
  const keyboard: Button[][] = numberRows(slice, first, { kind: 'list', page: p, background });
  const nav = navRow(p, pages, (n) => changesData({ kind: 'list', page: n, background }));
  if (nav.length) keyboard.push(nav);
  if (background) keyboard.push([{ text: 'Hide background changes', callback_data: changesData({ kind: 'list', page: 0, background: false }) }]);
  else if (hidden > 0) {
    keyboard.push([{
      text: `Show ${hidden} background ${hidden === 1 ? 'change' : 'changes'}`,
      callback_data: changesData({ kind: 'list', page: 0, background: true }),
    }]);
  }
  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}

/** `/changes <words>`: every entry in the log whose text matches, newest first. */
export function renderChangesSearch(read: ChangeLogRead, page: number, query: string): MenuScreen {
  const hits = read.entries.filter((e) => !isBackground(e) && matchesChangeSearch(e, query));
  const rows: ChangeRow[] = hits.map((entry) => ({ kind: 'entry', entry }));
  const { slice, page: p, pages } = pageOf(rows, page);
  const first = p * CHANGES_PAGE_SIZE;
  const lines = [`*Changes matching* ${escapeMarkdown(query)}`, ...(p === 0 ? noteLines(read) : [])];
  if (rows.length === 0) lines.push('', `Nothing in the last 90 days matches ${escapeMarkdown(query)}.`);
  else lines.push('', ...dayGrouped(slice, first));
  if (pages > 1) lines.push('', `Page ${p + 1} of ${pages}`);
  const keyboard = numberRows(slice, first, { kind: 'search', page: p, query });
  const nav = navRow(p, pages, (n) => changesData({ kind: 'search', page: n, query }));
  if (nav.length) keyboard.push(nav);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}

/** One sync run's imports. */
export function renderChangeRun(entries: ChangeLogItem[], view: Extract<ChangesView, { kind: 'run' }>): MenuScreen {
  const rows: ChangeRow[] = entries.map((entry) => ({ kind: 'entry', entry }));
  const { slice, page: p, pages } = pageOf(rows, view.page);
  const first = p * CHANGES_PAGE_SIZE;
  const lines = [
    `*Imported ${entries.length} ${entries.length === 1 ? 'transaction' : 'transactions'}*`,
    `_${shortDateTime(entries[0].at)}_`,
    '',
    ...slice.map((row, i) => rowLine(first + i + 1, row)),
  ];
  if (pages > 1) lines.push('', `Page ${p + 1} of ${pages}`);
  const here = { ...view, page: p };
  const keyboard = numberRows(slice, first, here);
  const nav = navRow(p, pages, (n) => changesData({ ...view, page: n }));
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: '‹ Back', callback_data: changesData({ kind: 'list', page: view.from.page, background: view.from.background }) }]);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}

/** What an entry's screen offers (R2). Absent: an R1 screen, no buttons. */
export interface DetailExtras {
  /** Undo or Redo is possible here. */
  op?: UndoOp;
  /** A rule's undo: how many charges it filed (null: unknown — no un-file button). */
  unfileCount?: number | null;
  /** What the last tap did, said once. */
  result?: { ok: boolean; message: string; needsSync?: boolean };
}

/** One entry: what, why, before → after, who and when — and, in R2, Undo/Redo. */
export function renderChangeDetail(
  entry: ChangeLogItem,
  back: Exclude<ChangesView, { kind: 'detail' | 'act' }>,
  extras: DetailExtras = {},
): MenuScreen {
  const lines = [escapeMarkdown(entry.summary)];
  const facts = [changeAmountText(entry), changeAccountText(entry)].filter(Boolean).map(escapeMarkdown);
  if (facts.length) lines.push(facts.join(' · '));
  if (entry.why) lines.push(`Why: ${escapeMarkdown(entry.why)}`);
  const beforeAfter = changeBeforeAfter(entry);
  if (beforeAfter) lines.push(`Before → after: ${escapeMarkdown(beforeAfter)}`);
  lines.push(`${changeSourceText(entry)} · ${shortDateTime(entry.at)}`);
  if (entry.undone) lines.push(`↩ Undone ${shortDateTime(entry.undone.at)}`);
  const r = extras.result;
  if (r) {
    lines.push('', `${r.ok ? '✅' : '⚠️'} ${escapeMarkdown(r.message)}`);
    if (r.ok && r.needsSync) lines.push(UNDO_TAKES_EFFECT);
  }
  const handle = findingHandle(entry.id);
  const act = (action: ChangeAction) => changesData({ kind: 'act', action, entry: handle, back });
  const keyboard: Button[][] = [];
  if (extras.op === 'redo') keyboard.push([{ text: 'Redo', callback_data: act('r') }]);
  else if (extras.op === 'undo' && entry.kind === 'category-rule-created') {
    const n = extras.unfileCount;
    keyboard.push([
      { text: '↩ Undo rule', callback_data: act('u') },
      ...(n ? [{ text: `↩ Undo rule + un-file ${n}`, callback_data: act('f') }] : []),
    ]);
  } else if (extras.op === 'undo') keyboard.push([{ text: '↩ Undo', callback_data: act('u') }]);
  if (r?.ok && r.needsSync) keyboard.push([{ text: '🔄 Sync now', callback_data: act('s') }]);
  keyboard.push([{
    text: '‹ Back',
    callback_data: back.kind === 'why' ? `${WHY_CALLBACK_PREFIX}t${back.activityId}:c` : changesData(back),
  }]);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}

/** `/changes` and `/changes <words>`: the first screen, as a reply. */
export function renderChangesCommand(read: ChangeLogRead, args: string, now: Date): MenuScreen {
  const query = normalizeChangesQuery(args);
  return query ? renderChangesSearch(read, 0, query) : renderChangesList(read, 0, false, now);
}

export interface ChangesMenuUi {
  edit(text: string, keyboard?: InlineKeyboard): Promise<void>;
  answer(text?: string): Promise<void>;
  /** A NEW message — where Sync now's summary goes. */
  send?(text: string, keyboard?: InlineKeyboard): Promise<void>;
}

export interface ChangesMenuDeps {
  /** Re-read on every tap. Rejects when Wealthfolio cannot be reached. */
  read(now: Date): Promise<ChangeLogRead>;
  now(): Date;
  log(msg: string): void;
  /** R2: undo or redo one entry (shared/change-undo-run.ts). Absent: read-only. */
  undo?(entry: ChangeLogItem, entries: ChangeLogItem[], op: UndoOp, variant: UndoVariant): Promise<UndoOutcome>;
  /** N for a rule's "Undo rule + un-file N", read when its screen is shown. */
  ruleFiledCount?(entry: ChangeLogItem): Promise<number | null>;
  /** The `/sync` run: started, or joined; the summary never rejects. */
  syncNow?(): { started: boolean; summary: Promise<string> };
}

export interface ChangesMenu {
  handles(data: string): boolean;
  onCallback(cb: { data: string; chatId: number }, ui: ChangesMenuUi): Promise<void>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createChangesMenu(deps: ChangesMenuDeps): ChangesMenu {
  const renderView = (read: ChangeLogRead, view: Extract<ChangesView, { kind: 'list' | 'search' }>, now: Date) =>
    (view.kind === 'list' ? renderChangesList(read, view.page, view.background, now) : renderChangesSearch(read, view.page, view.query));

  /** The entry's screen, with its Undo/Redo buttons when this menu can undo. */
  const detailScreen = async (entry: ChangeLogItem, back: Exclude<ChangesView, { kind: 'detail' | 'act' }>, result?: DetailExtras['result']) => {
    if (!deps.undo) return renderChangeDetail(entry, back, result ? { result } : {});
    const available = undoAvailability(entry, { host: 'companion', companionVersion: null });
    const op = available.kind === 'ready' ? available.op : undefined;
    const unfileCount = op === 'undo' && entry.kind === 'category-rule-created'
      ? await deps.ruleFiledCount?.(entry).catch(() => null) ?? null
      : null;
    return renderChangeDetail(entry, back, { ...(op ? { op } : {}), unfileCount, ...(result ? { result } : {}) });
  };

  return {
    handles(data) {
      return data.startsWith(CHANGES_CALLBACK_PREFIX);
    },

    async onCallback(cb, ui) {
      try {
        const view = parseChangesData(cb.data);
        if (!view) return void await ui.answer();
        const now = deps.now();
        let read: ChangeLogRead;
        try {
          read = await deps.read(now);
        } catch (err) {
          deps.log(`Changes menu: reading failed: ${message(err)}`);
          return void await ui.answer(CHANGES_UNREACHABLE_REPLY);
        }
        const show = async (screen: MenuScreen, toast?: string) => {
          await ui.edit(screen.text, screen.keyboard);
          await ui.answer(toast);
        };
        const gone = () => show(renderChangesList(read, 0, false, now), CHANGES_GONE_ANSWER);
        const runEntries = (handle: string) =>
          read.entries.filter((e) => e.kind === 'import' && e.run && runHandle(e.run) === handle);

        switch (view.kind) {
          case 'list':
          case 'search':
            return void await show(renderView(read, view, now));
          case 'run': {
            const entries = runEntries(view.run);
            return void await (entries.length ? show(renderChangeRun(entries, view)) : gone());
          }
          case 'detail': {
            const entry = read.entries.find((e) => findingHandle(e.id) === view.entry);
            if (!entry) return void await gone();
            if (view.back.kind === 'run' && runEntries(view.back.run).length === 0) return void await gone();
            return void await show(await detailScreen(entry, view.back));
          }
          case 'act': {
            const entry = read.entries.find((e) => findingHandle(e.id) === view.entry);
            if (!entry) return void await gone();
            if (view.action === 's') {
              if (!deps.syncNow) return void await ui.answer();
              const { started, summary } = deps.syncNow();
              await ui.answer(started ? CHANGES_SYNC_STARTED : CHANGES_SYNC_RUNNING);
              // Not awaited: a sync takes tens of seconds, and the summary
              // promise cannot reject.
              void summary.then((text) => ui.send?.(text)).catch((err) => deps.log(`Changes menu: sync summary not sent: ${message(err)}`));
              return;
            }
            if (!deps.undo) return void await ui.answer();
            const op: UndoOp = view.action === 'r' ? 'redo' : 'undo';
            const outcome = await deps.undo(entry, read.entries, op, view.action === 'f' ? 'unfile' : 'plain');
            // Re-read so the screen shows the entry as it now stands (Undone,
            // and Redo offered); the old read stands in if that fails.
            const fresh = outcome.ok ? await deps.read(deps.now()).catch(() => read) : read;
            const now2 = fresh.entries.find((e) => e.id === entry.id) ?? entry;
            return void await show(await detailScreen(now2, view.back, {
              ok: outcome.ok, message: outcome.message, ...(outcome.ok ? { needsSync: outcome.needsSync } : {}),
            }));
          }
        }
      } catch (err) {
        deps.log(`Changes menu: ${cb.data} failed: ${message(err)}`);
        await ui.answer(FAILED_ANSWER).catch(() => {});
      }
    },
  };
}
