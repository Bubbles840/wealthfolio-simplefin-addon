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
 */
import { MENU_CALLBACK_PREFIX } from '../../shared/categorize-menu.js';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log.js';
import { changeDay } from '../../shared/change-entries.js';
import {
  changeAccountText, changeAmountText, changeBeforeAfter, changeClock, changeLocalDay, changeLogNotes, changeRowAt,
  changeRows, changeRowSummary, changeSourceText, changesWithin, isBackground, matchesChangeSearch, type ChangeRow,
} from '../../shared/change-view.js';
import { findingHandle } from '../../shared/handle.js';
import { escapeMarkdown, shortDateTime, type InlineKeyboard } from '../../shared/telegram.js';

export const CHANGES_CALLBACK_PREFIX = `${MENU_CALLBACK_PREFIX}cl:`;
export const CHANGES_PAGE_SIZE = 8;
export const CHANGES_LIST_DAYS = 7;
/** A search rides inside every button of its screens, so it is cut to fit 64 bytes. */
export const CHANGES_QUERY_MAX_BYTES = 30;
export const CHANGES_GONE_ANSWER = 'That one is already sorted — refreshing.';
export const CHANGES_UNREACHABLE_REPLY = "Couldn't reach Wealthfolio — try again.";
const FAILED_ANSWER = 'Could not do that — check the companion logs.';

type Button = { text: string; callback_data: string };
export interface MenuScreen { text: string; keyboard: InlineKeyboard }

/** Where a screen is, and so where a button leads. */
export type ChangesView =
  | { kind: 'list'; page: number; background: boolean }
  | { kind: 'search'; page: number; query: string }
  | { kind: 'run'; run: string; page: number; from: { page: number; background: boolean } }
  | { kind: 'detail'; entry: string; back: Exclude<ChangesView, { kind: 'detail' }> };

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
  m = /^d([0-9a-f]{8}):(.+)$/s.exec(s);
  if (m && allowDetail) {
    const back = decodeView(m[2], false);
    return back && back.kind !== 'detail' ? { kind: 'detail', entry: m[1], back } : null;
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
function numberRows(rows: ChangeRow[], first: number, back: Exclude<ChangesView, { kind: 'detail' }>): Button[][] {
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

const noteLines = (read: ChangeLogRead) => changeLogNotes(read).map((n) => `⚠️ ${escapeMarkdown(n)}`);

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
    `*Imported ${entries.length} transactions*`,
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

/** One entry: what, why, before → after, who and when. */
export function renderChangeDetail(entry: ChangeLogItem, back: Exclude<ChangesView, { kind: 'detail' }>): MenuScreen {
  const lines = [escapeMarkdown(entry.summary)];
  const facts = [changeAmountText(entry), changeAccountText(entry)].filter(Boolean).map(escapeMarkdown);
  if (facts.length) lines.push(facts.join(' · '));
  if (entry.why) lines.push(`Why: ${escapeMarkdown(entry.why)}`);
  const beforeAfter = changeBeforeAfter(entry);
  if (beforeAfter) lines.push(`Before → after: ${escapeMarkdown(beforeAfter)}`);
  lines.push(`${changeSourceText(entry)} · ${shortDateTime(entry.at)}`);
  if (entry.undone) lines.push(`↩ Undone ${shortDateTime(entry.undone.at)}`);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: [[{ text: '‹ Back', callback_data: changesData(back) }]] } };
}

/** `/changes` and `/changes <words>`: the first screen, as a reply. */
export function renderChangesCommand(read: ChangeLogRead, args: string, now: Date): MenuScreen {
  const query = normalizeChangesQuery(args);
  return query ? renderChangesSearch(read, 0, query) : renderChangesList(read, 0, false, now);
}

export interface ChangesMenuUi {
  edit(text: string, keyboard?: InlineKeyboard): Promise<void>;
  answer(text?: string): Promise<void>;
}

export interface ChangesMenuDeps {
  /** Re-read on every tap. Rejects when Wealthfolio cannot be reached. */
  read(now: Date): Promise<ChangeLogRead>;
  now(): Date;
  log(msg: string): void;
}

export interface ChangesMenu {
  handles(data: string): boolean;
  onCallback(cb: { data: string; chatId: number }, ui: ChangesMenuUi): Promise<void>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createChangesMenu(deps: ChangesMenuDeps): ChangesMenu {
  const renderView = (read: ChangeLogRead, view: Exclude<ChangesView, { kind: 'detail' | 'run' }>, now: Date) =>
    (view.kind === 'list' ? renderChangesList(read, view.page, view.background, now) : renderChangesSearch(read, view.page, view.query));

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
            return void await show(renderChangeDetail(entry, view.back));
          }
        }
      } catch (err) {
        deps.log(`Changes menu: ${cb.data} failed: ${message(err)}`);
        await ui.answer(FAILED_ANSWER).catch(() => {});
      }
    },
  };
}
