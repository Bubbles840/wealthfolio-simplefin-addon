/**
 * companion/src/why-menu.ts
 *
 * `/why`: one transaction's story in Telegram (shared/tx-story.ts).
 * `/why <words and/or an amount>` searches every transaction; bare `/why`
 * asks for them (the R1 ask engine, like `/newrule`). Results are buttons,
 * 8 a page, newest first; a tap opens the story IN PLACE with ⬅️ Back to the
 * results. Each line of "What happened" is a numbered button into `/changes`'
 * entry view, where Undo lives; that view's ‹ Back returns to the story.
 *
 * A 🔎 Why? button elsewhere (the large-transaction alert, the `/categorize`
 * screen) sends the story as a NEW message, never editing the one it sits on;
 * so does the import notice's, which lists that sync's imports first.
 *
 * STATELESS, like changes-menu.ts: every tap re-reads, and every button
 * carries where it leads. After `cz:wy:`:
 *   s<page>:<query>            results, in place
 *   t<id>                      a story as a NEW message (a 🔎 Why? button)
 *   t<id>:c                    a story in place, back from /changes
 *   t<id>:s<page>:<query>      a story in place; Back to those results
 *   t<id>:r<handle>:<page>     a story in place; Back to a sync's imports
 *   r<handle>                  a sync's imports as a NEW message (the import notice)
 *   r<handle>:<page>           a sync's imports, in place
 *   d<id>                      R2: "Remove for good…" — the confirm screen, in place
 *   D<id>:<fingerprint>        R2: remove it, then say what happened, in place
 * `<id>` is an activity id; `<handle>` is `findingHandle(runId)`;
 * `<fingerprint>` is `removalFingerprint` of the row as the confirm screen
 * showed it (shared/tx-remove.ts), 8 hex. A query is cut to
 * WHY_QUERY_MAX_BYTES so the longest story button fits 64 bytes; the longest
 * remove button is 52.
 *
 * "Remove for good…" (2c R2) shows on a story only when the deps can remove
 * (`remove`) and the row qualifies (`removalOffered`). Its first tap edits
 * the story into the confirm screen — Remove, or Cancel back to the story —
 * and Remove re-reads the row and refuses, in place, if it changed since.
 *
 * Bank and user text is escaped AND kept outside every `*…*`/`_…_`; button
 * labels are plain text and are not escaped.
 */
import type { AskFlow } from '../../shared/ask-flow.js';
import { changeDayYear, changeMoney } from '../../shared/change-entries.js';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log.js';
import { currentActivityId } from '../../shared/change-view.js';
import { findingHandle } from '../../shared/handle.js';
import { escapeMarkdown, shortDateTime, WHY_CALLBACK_PREFIX, type InlineKeyboard } from '../../shared/telegram.js';
import {
  isEmptyTxQuery, parseTxQuery, txQueryText, txSearchPage, TX_SEARCH_TOO_MANY, type TxQuery, type TxSearchResult,
} from '../../shared/tx-search.js';
import { TX_STORY_GONE, TX_STORY_NO_HISTORY, TX_STORY_UNREACHABLE, TX_STORY_WHAT_HAPPENED, type TxStory } from '../../shared/tx-story.js';
import {
  removalFingerprint, removalOffered, REMOVE_ACTION, REMOVE_BUTTON, REMOVE_CANCEL, REMOVE_CONFIRM, type RemoveOutcome,
} from '../../shared/tx-remove.js';
import { changesData } from './changes-menu.js';
import type { SearchOutcome, StoryOutcome } from './tx-story-host.js';

/** 64 − `cz:wy:t` (7) − a 36-character activity id − `:s0:` (4): the query
 *  every story button carries for its Back. */
export const WHY_QUERY_MAX_BYTES = 17;
export const WHY_TITLE = 'Why is this here?';
export const WHY_ASK_PROMPT = 'Which transaction? Send a few words or an amount.';
export const WHY_ASK_HINT = 'Send a few words from its description, an amount, or both.';
export const WHY_TAP_ONE = 'Tap one to see its story.';
export const WHY_RECENT_ONLY = "Searched the last 12 months — the companion couldn't read the database.";
export const WHY_RUN_TITLE = 'What this sync imported';
export const WHY_RUN_GONE = "That sync is past the change log's 90 days — search with /why.";
/** "What happened" lines one message shows: the newest ones. */
export const WHY_HISTORY_MAX = 20;
const FAILED_ANSWER = 'Could not do that — check the companion logs.';

type Button = { text: string; callback_data: string };
export interface MenuScreen { text: string; keyboard: InlineKeyboard }

/** Where a story's ⬅️ Back leads. `none`: a story sent as a new message;
 *  `changes`: reached from /changes' Back, in place, with no Back of its own. */
export type StoryBack =
  | { kind: 'none' }
  | { kind: 'changes' }
  | { kind: 'search'; page: number; query: string }
  | { kind: 'run'; run: string; page: number };

export type WhyView =
  | { kind: 'search'; page: number; query: string }
  | { kind: 'story'; activityId: string; back: StoryBack }
  /** `fresh`: from the import notice — sent as a new message. */
  | { kind: 'run'; run: string; page: number; fresh: boolean }
  /** R2: the confirm screen of "Remove for good…". */
  | { kind: 'remove-ask'; activityId: string }
  /** R2: remove it, if it still reads as the confirm screen showed it. */
  | { kind: 'remove'; activityId: string; fingerprint: string };

export function whyData(view: WhyView): string {
  switch (view.kind) {
    case 'search': return `${WHY_CALLBACK_PREFIX}s${view.page}:${view.query}`;
    case 'run': return `${WHY_CALLBACK_PREFIX}r${view.run}${view.fresh ? '' : `:${view.page}`}`;
    case 'remove-ask': return `${WHY_CALLBACK_PREFIX}d${view.activityId}`;
    case 'remove': return `${WHY_CALLBACK_PREFIX}D${view.activityId}:${view.fingerprint}`;
    case 'story': {
      const b = view.back;
      const tail = b.kind === 'none' ? ''
        : b.kind === 'changes' ? ':c'
          : b.kind === 'search' ? `:s${b.page}:${b.query}`
            : `:r${b.run}:${b.page}`;
      return `${WHY_CALLBACK_PREFIX}t${view.activityId}${tail}`;
    }
  }
}

/** The handle a sync's run rides in a `cz:wy:r` button as; the import notice's
 *  🔎 button must build it with this too. */
export const whyRunHandle = (run: string): string => findingHandle(run);

/** The view a button carries, or null for anything this menu never emitted. */
export function parseWhyData(data: string): WhyView | null {
  if (!data.startsWith(WHY_CALLBACK_PREFIX)) return null;
  const s = data.slice(WHY_CALLBACK_PREFIX.length);
  let m = /^s(\d{1,3}):(.+)$/s.exec(s);
  if (m) return { kind: 'search', page: Number(m[1]), query: m[2] };
  m = /^r([0-9a-f]{8})$/.exec(s);
  if (m) return { kind: 'run', run: m[1], page: 0, fresh: true };
  m = /^r([0-9a-f]{8}):(\d{1,3})$/.exec(s);
  if (m) return { kind: 'run', run: m[1], page: Number(m[2]), fresh: false };
  m = /^t([^:\s]{1,64})$/.exec(s);
  if (m) return { kind: 'story', activityId: m[1], back: { kind: 'none' } };
  m = /^t([^:\s]{1,64}):c$/.exec(s);
  if (m) return { kind: 'story', activityId: m[1], back: { kind: 'changes' } };
  m = /^t([^:\s]{1,64}):s(\d{1,3}):(.+)$/s.exec(s);
  if (m) return { kind: 'story', activityId: m[1], back: { kind: 'search', page: Number(m[2]), query: m[3] } };
  m = /^t([^:\s]{1,64}):r([0-9a-f]{8}):(\d{1,3})$/.exec(s);
  if (m) return { kind: 'story', activityId: m[1], back: { kind: 'run', run: m[2], page: Number(m[3]) } };
  m = /^d([^:\s]{1,64})$/.exec(s);
  if (m) return { kind: 'remove-ask', activityId: m[1] };
  m = /^D([^:\s]{1,64}):([0-9a-f]{8})$/.exec(s);
  if (m) return { kind: 'remove', activityId: m[1], fingerprint: m[2] };
  return null;
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** A search as buttons carry it: the amount first (`$<amount>`), then the
 *  words, single-spaced. Too long, it loses words from the end — never the
 *  amount — and a single word too long loses characters. Either way it only
 *  ever matches MORE. */
export function normalizeWhyQuery(raw: string): string {
  const q = parseTxQuery(raw);
  const words = [...q.words];
  const amount = q.amount ? [`$${q.amount.text}`] : [];
  // `$amount` FIRST, so the text parses back to this same query (txQueryText).
  const text = () => [...amount, ...words].join(' ');
  while (bytes(text()) > WHY_QUERY_MAX_BYTES && words.length > (amount.length ? 0 : 1)) words.pop();
  let t = text();
  while (bytes(t) > WHY_QUERY_MAX_BYTES) t = Array.from(t).slice(0, -1).join('');
  return t.trim();
}

/** Telegram rejects a message over this many characters. */
const TELEGRAM_MAX = 4096;
/** A removal's message carries raw bank and Wealthfolio text; cut it so even
 *  fully escaped (up to twice as long) it leaves room for the story. */
const REMOVE_MESSAGE_MAX = 1000;
const REMOVE_ALREADY_GONE = "It's already gone — nothing more to do.";

const clip = (s: string, n: number) => {
  const chars = Array.from(s);
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : s;
};

/** A result's button: date · description · amount · account. */
function rowLabel(r: { date: string; description: string; amountCents: number; accountName: string }, now: Date): string {
  return [changeDayYear(r.date, now), clip(r.description || 'A transaction', 28), changeMoney(r.amountCents), clip(r.accountName, 20)]
    .filter(Boolean).join(' · ');
}

function navRow(page: number, pages: number, at: (page: number) => string): Button[] {
  const nav: Button[] = [];
  if (page < pages - 1) nav.push({ text: '‹ Older', callback_data: at(page + 1) });
  if (page > 0) nav.push({ text: 'Newer ›', callback_data: at(page - 1) });
  return nav;
}

/** "Nothing matches", pointing at `/changes` for a removed transaction. Raw. */
export function whyNoMatch(q: TxQuery): string {
  return q.words.length
    ? `Nothing matches. If it was removed, try /changes ${q.words.join(' ')}.`
    : 'Nothing matches. If it was removed, try /changes with a word from its description.';
}

export function renderWhyResults(found: { result: TxSearchResult; recentOnly: boolean }, query: string, page: number, now: Date): MenuScreen {
  const lines = [`🔎 *${WHY_TITLE}* ${escapeMarkdown(query)}`];
  if (found.recentOnly) lines.push(WHY_RECENT_ONLY);
  if (found.result.rows.length === 0) {
    lines.push('', escapeMarkdown(whyNoMatch(parseTxQuery(query))));
    return { text: lines.join('\n'), keyboard: { inline_keyboard: [] } };
  }
  const { slice, page: p, pages } = txSearchPage(found.result.rows, page);
  lines.push('', WHY_TAP_ONE);
  if (pages > 1) lines.push(`Page ${p + 1} of ${pages}`);
  if (found.result.truncated) lines.push(TX_SEARCH_TOO_MANY);
  const keyboard: Button[][] = slice.map((r) => [{
    text: rowLabel(r, now),
    callback_data: whyData({ kind: 'story', activityId: r.activityId, back: { kind: 'search', page: p, query } }),
  }]);
  const nav = navRow(p, pages, (n) => whyData({ kind: 'search', page: n, query }));
  if (nav.length) keyboard.push(nav);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}

/** R2: what a story screen adds. `removable`: offer "Remove for good…";
 *  `notice`: why the last tap did nothing, on top. */
export interface StoryScreenOptions {
  removable?: boolean;
  notice?: string;
}

/** "Remove for good…", first tap: the story's row and what Remove does. */
export function renderWhyRemoveConfirm(story: TxStory, activityId: string, fingerprint: string): MenuScreen {
  const lines = [`🔎 ${escapeMarkdown(story.title)}`];
  if (story.accountLine) lines.push(escapeMarkdown(story.accountLine));
  lines.push('', escapeMarkdown(REMOVE_CONFIRM));
  return {
    text: lines.join('\n'),
    keyboard: {
      inline_keyboard: [
        [{ text: REMOVE_BUTTON, callback_data: whyData({ kind: 'remove', activityId, fingerprint }) }],
        [{ text: REMOVE_CANCEL, callback_data: whyData({ kind: 'story', activityId, back: { kind: 'changes' } }) }],
      ],
    },
  };
}

export function renderWhyStory(story: TxStory, activityId: string, back: StoryBack, opts: StoryScreenOptions = {}): MenuScreen {
  const lines = [...(opts.notice ? [`⚠️ ${escapeMarkdown(opts.notice)}`] : []), `🔎 ${escapeMarkdown(story.title)}`];
  if (story.accountLine) lines.push(escapeMarkdown(story.accountLine));
  if (story.answer.length) lines.push('', ...story.answer.map(escapeMarkdown));
  const numbers: Button[] = [];
  if (story.history) {
    lines.push('', `*${TX_STORY_WHAT_HAPPENED}*`);
    // A log read in part can't say nothing happened: its note says why the list may be short.
    if (story.history.length === 0 && !story.historyPartial) lines.push(TX_STORY_NO_HISTORY);
    const shown = story.history.slice(-WHY_HISTORY_MAX);
    const hidden = story.history.length - shown.length;
    if (hidden > 0) lines.push(`…and ${hidden} earlier — /changes lists them.`);
    shown.forEach((h, i) => {
      lines.push(`${i + 1}. ${escapeMarkdown(h.line)}`);
      numbers.push({
        text: String(i + 1),
        callback_data: changesData({ kind: 'detail', entry: findingHandle(h.entryId), back: { kind: 'why', activityId } }),
      });
    });
  }
  if (story.notes.length) lines.push('', ...story.notes.map((n) => `⚠️ ${escapeMarkdown(n)}`));
  const keyboard: Button[][] = [];
  for (let i = 0; i < numbers.length; i += 4) keyboard.push(numbers.slice(i, i + 4));
  if (opts.removable) keyboard.push([{ text: REMOVE_ACTION, callback_data: whyData({ kind: 'remove-ask', activityId }) }]);
  if (back.kind === 'search') keyboard.push([{ text: '⬅️ Back', callback_data: whyData({ kind: 'search', page: back.page, query: back.query }) }]);
  if (back.kind === 'run') keyboard.push([{ text: '⬅️ Back', callback_data: whyData({ kind: 'run', run: back.run, page: back.page, fresh: false }) }]);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}

/** One sync's imports (its import entries in the log, newest first). Each
 *  opens the row that stands for it NOW (`current`, `currentActivityId` over
 *  the log): a link in the same sync re-creates both legs under new ids. */
export function renderWhyRun(
  entries: ChangeLogItem[], run: string, page: number, now: Date, current: (activityId: string) => string = (id) => id,
): MenuScreen {
  if (entries.length === 0) return { text: `🔎 *${WHY_RUN_TITLE}*\n\n${escapeMarkdown(WHY_RUN_GONE)}`, keyboard: { inline_keyboard: [] } };
  const { slice, page: p, pages } = txSearchPage(entries, page);
  const lines = [`🔎 *${WHY_RUN_TITLE}*`, `_${shortDateTime(entries[0].at)}_`, '', WHY_TAP_ONE];
  if (pages > 1) lines.push(`Page ${p + 1} of ${pages}`);
  const keyboard: Button[][] = slice.map((e) => [{
    text: rowLabel({
      date: e.subject.date ?? e.at.slice(0, 10), description: e.subject.description ?? '',
      amountCents: e.subject.amountCents ?? 0, accountName: e.account?.name ?? '',
    }, now),
    callback_data: whyData({ kind: 'story', activityId: current(e.subject.activityIds![0]), back: { kind: 'run', run, page: p } }),
  }]);
  const nav = navRow(p, pages, (n) => whyData({ kind: 'run', run, page: n, fresh: false }));
  if (nav.length) keyboard.push(nav);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}

/** Bare `/why`: one question, then the results (index.ts registers it). */
export function buildWhyFlow(): AskFlow {
  return {
    id: 'why',
    command: 'why',
    title: WHY_TITLE,
    steps: [{
      id: 'query',
      kind: 'text',
      prompt: () => WHY_ASK_PROMPT,
      parse: (input) => (isEmptyTxQuery(parseTxQuery(input)) ? { ok: false, hint: WHY_ASK_HINT } : { ok: true, value: input }),
    }],
  };
}

type Send = (text: string, keyboard?: InlineKeyboard) => Promise<void>;

export interface WhyMenuUi {
  edit(text: string, keyboard?: InlineKeyboard): Promise<void>;
  answer(text?: string): Promise<void>;
  /** A NEW message. */
  send: Send;
}

export interface WhyMenuDeps {
  search(query: TxQuery, now: Date): Promise<SearchOutcome>;
  story(activityId: string, now: Date): Promise<StoryOutcome>;
  /** The change log, for a sync's imports. Rejects when unreachable. */
  read(now: Date): Promise<ChangeLogRead>;
  /** R2: remove a row for good (shared/tx-remove.ts `removeForGood`). Absent: never offered. */
  remove?(activityId: string, fingerprint: string, now: Date): Promise<RemoveOutcome>;
  now(): Date;
  log(msg: string): void;
}

export interface WhyMenu {
  handles(data: string): boolean;
  onCallback(cb: { data: string }, ui: WhyMenuUi): Promise<void>;
  /** `/why <text>` and the question's answer: the first page, as a reply. */
  reply(text: string, send: Send): Promise<void>;
  /** A 🔎 Why? from another menu: the story as a new message. */
  sendStory(activityId: string, send: Send): Promise<void>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** An empty keyboard is sent as none. */
const sendScreen = (send: Send, s: MenuScreen) => (s.keyboard.inline_keyboard.length ? send(s.text, s.keyboard) : send(s.text));

export function createWhyMenu(deps: WhyMenuDeps): WhyMenu {
  const runImports = (read: ChangeLogRead, handle: string) =>
    read.entries.filter((e) => e.kind === 'import' && e.run && whyRunHandle(e.run) === handle && !!e.subject.activityIds?.[0]);
  /** R2: a story offers "Remove for good…" only when this menu can remove. */
  const removable = (out: Extract<StoryOutcome, { kind: 'ok' }>) => !!deps.remove && removalOffered(out.facts);

  return {
    handles(data) {
      return data.startsWith(WHY_CALLBACK_PREFIX);
    },

    async reply(text, send) {
      const query = normalizeWhyQuery(text);
      const q = parseTxQuery(query);
      if (isEmptyTxQuery(q)) return void await send(WHY_ASK_HINT);
      const out = await deps.search(q, deps.now());
      if (out.kind === 'unreachable') return void await send(TX_STORY_UNREACHABLE);
      await sendScreen(send, renderWhyResults(out, txQueryText(q), 0, deps.now()));
    },

    async sendStory(activityId, send) {
      const out = await deps.story(activityId, deps.now());
      if (out.kind === 'unreachable') return void await send(TX_STORY_UNREACHABLE);
      if (out.kind === 'gone') return void await send(TX_STORY_GONE);
      await sendScreen(send, renderWhyStory(out.story, out.movedTo ?? activityId, { kind: 'none' }, { removable: removable(out) }));
    },

    async onCallback(cb, ui) {
      try {
        const view = parseWhyData(cb.data);
        if (!view) return void await ui.answer();
        const now = deps.now();
        const show = async (screen: MenuScreen, fresh: boolean) => {
          if (fresh) await sendScreen(ui.send, screen);
          else await ui.edit(screen.text, screen.keyboard);
          await ui.answer();
        };
        switch (view.kind) {
          case 'search': {
            const out = await deps.search(parseTxQuery(view.query), now);
            if (out.kind === 'unreachable') return void await ui.answer(TX_STORY_UNREACHABLE);
            return void await show(renderWhyResults(out, view.query, view.page, now), false);
          }
          case 'story': {
            const out = await deps.story(view.activityId, now);
            if (out.kind === 'unreachable') return void await ui.answer(TX_STORY_UNREACHABLE);
            if (out.kind === 'gone') return void await ui.answer(TX_STORY_GONE);
            // A row that moved (a link re-created it) is the one its history lines come back to.
            return void await show(
              renderWhyStory(out.story, out.movedTo ?? view.activityId, view.back, { removable: removable(out) }),
              view.back.kind === 'none',
            );
          }
          case 'remove-ask': {
            if (!deps.remove) return void await ui.answer();
            const out = await deps.story(view.activityId, now);
            if (out.kind === 'unreachable') return void await ui.answer(TX_STORY_UNREACHABLE);
            if (out.kind === 'gone') return void await ui.answer(TX_STORY_GONE);
            // No longer qualifies (pending now, say): the story as it is, with no Remove button.
            if (!removable(out)) return void await show(renderWhyStory(out.story, out.movedTo ?? view.activityId, { kind: 'changes' }, { removable: false }), false);
            return void await show(renderWhyRemoveConfirm(out.story, out.movedTo ?? view.activityId, removalFingerprint(out.facts.row)), false);
          }
          case 'remove': {
            if (!deps.remove) return void await ui.answer();
            const result = await deps.remove(view.activityId, view.fingerprint, now);
            const said = clip(result.message, REMOVE_MESSAGE_MAX);
            if (result.ok) return void await show({ text: `🔎 ${escapeMarkdown(said)}`, keyboard: { inline_keyboard: [] } }, false);
            // Refused: the story again, as it is now, with why on top.
            const out = await deps.story(view.activityId, now);
            const refusedAlone: MenuScreen = { text: `⚠️ ${escapeMarkdown(said)}`, keyboard: { inline_keyboard: [] } };
            // Gone: a double tap's second run, after the first removed it. Leave that result standing.
            if (out.kind === 'gone') return void await ui.answer(REMOVE_ALREADY_GONE);
            if (out.kind !== 'ok') return void await show(refusedAlone, false);
            const again = renderWhyStory(out.story, out.movedTo ?? view.activityId, { kind: 'changes' }, { removable: removable(out), notice: said });
            return void await show(again.text.length <= TELEGRAM_MAX ? again : refusedAlone, false);
          }
          case 'run': {
            let read: ChangeLogRead;
            try {
              read = await deps.read(now);
            } catch (err) {
              deps.log(`Why menu: reading the change log failed: ${message(err)}`);
              return void await ui.answer(TX_STORY_UNREACHABLE);
            }
            const entries = runImports(read, view.run);
            if (entries.length === 0) return void await ui.answer(WHY_RUN_GONE);
            return void await show(renderWhyRun(entries, view.run, view.page, now, (id) => currentActivityId(read.entries, id)), view.fresh);
          }
        }
      } catch (err) {
        deps.log(`Why menu: ${cb.data} failed: ${message(err)}`);
        await ui.answer(FAILED_ANSWER).catch(() => {});
      }
    },
  };
}
