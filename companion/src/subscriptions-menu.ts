/**
 * companion/src/subscriptions-menu.ts
 *
 * `/subscriptions` and every button that leads into it: the list, one screen
 * per entry, the maybes, the hidden ones, and the writes — remind, hide,
 * confirm, delete, link — with ↩ Undo.
 *
 * STATELESS, like findings-menu.ts. Every tap re-reads the roster and finds
 * the tapped entry by the hash of its key, so a button from Monday's report
 * still works after a restart, and one whose entry has gone answers "That one
 * is already sorted" instead of acting on a stale snapshot.
 *
 * Writes go through `deps.edit` — `editSubscriptionPrefs` in production:
 * re-read, one pure edit, write, mirror the legacy lists. Instant, no confirm
 * screen; the screen after a write carries ↩ Undo.
 *
 * Names are escaped and never put inside bold: legacy Markdown ignores an
 * escape inside an entity, and a bank's `*` would cost the whole message.
 */
import { askStartData } from '../../shared/ask-flow.js';
import { MENU_CALLBACK_PREFIX } from '../../shared/categorize-menu.js';
import { findingHandle } from '../../shared/findings.js';
import {
  acceptLink, confirmKey, declineLink, deleteManual, hideKey, isUnreadablePrefsError, SubscriptionPrefsInvalidError, restoreDeleted, setRemind,
  unconfirmKey, undoRename, unhideEntry, type RemindDays, type SubscriptionEdit, type SubscriptionPrefs,
} from '../../shared/subscription-prefs.js';
import {
  manualKey, normalizeRosterKey, rosterAmount, rosterMoney, rosterWhen, type Roster, type RosterEntry,
} from '../../shared/subscription-roster.js';
import {
  escapeMarkdown, formatSubscriptionList, shortDate, subscriptionListPage, type InlineKeyboard,
} from '../../shared/telegram.js';
import type { RosterRead } from './subscription-data.js';

export const SUBSCRIPTIONS_CALLBACK_PREFIX = `${MENU_CALLBACK_PREFIX}sb:`;
/** From a report: the list as a NEW message — editing would draw it over the
 *  report, the only copy of the morning's numbers in the chat. */
export const OPEN_SUBSCRIPTIONS = `${SUBSCRIPTIONS_CALLBACK_PREFIX}o`;
const LIST = `${SUBSCRIPTIONS_CALLBACK_PREFIX}l:`;
const MAYBES = `${SUBSCRIPTIONS_CALLBACK_PREFIX}mb`;
const HIDDEN = `${SUBSCRIPTIONS_CALLBACK_PREFIX}hd`;
const ACTION = /^([a-z]{1,2}|r[0137]):([0-9a-f]{8})$/;
const act = (action: string, handle: string) => `${SUBSCRIPTIONS_CALLBACK_PREFIX}${action}:${handle}`;

type Button = { text: string; callback_data: string };
export interface MenuScreen { text: string; keyboard: InlineKeyboard }

export const SUBSCRIPTIONS_BUTTON: Button = { text: '💳 Subscriptions', callback_data: OPEN_SUBSCRIPTIONS };
export const SEE_ALL_SUBSCRIPTIONS_BUTTON: Button = { text: 'See all', callback_data: OPEN_SUBSCRIPTIONS };
export const SUBSCRIPTIONS_GONE_ANSWER = 'That one is already sorted — refreshing.';
export const SUBSCRIPTIONS_UNREACHABLE_REPLY = "Couldn't reach Wealthfolio — try again.";
export const SUBSCRIPTIONS_UNREADABLE_REPLY = "Couldn't read your subscription settings — nothing was changed.";
export const SUBSCRIPTIONS_RENAME_GONE_REPLY = 'That one is gone now — send /subscriptions for the current list.';
export const SUBSCRIPTIONS_INVALID_REPLY = "Couldn't save that — nothing was changed.";
const FAILED_ANSWER = 'Could not do that — check the companion logs.';

const BACK_TO_LIST: Button = { text: '‹ Subscriptions', callback_data: `${LIST}0` };
const BACK: Button = { text: '‹ Back', callback_data: `${LIST}0` };
/** Button labels are plain text (never parsed as Markdown), only shortened. */
const label = (name: string, max = 28) => {
  const chars = Array.from(name); // code points: an emoji is never cut in half
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : name;
};
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface SubscriptionsMenuUi {
  edit(text: string, keyboard?: InlineKeyboard): Promise<void>;
  answer(text?: string): Promise<void>;
  send(text: string, keyboard?: InlineKeyboard): Promise<void>;
}

export interface SubscriptionsMenuDeps {
  /** Re-read on every tap. Rejects when Wealthfolio cannot be reached. */
  read(now: Date): Promise<RosterRead>;
  /** editSubscriptionPrefs; rejects with SubscriptionPrefsUnreadableError on a corrupt document. */
  edit(edit: SubscriptionEdit, now: Date): Promise<SubscriptionPrefs>;
  now(): Date;
  log(msg: string): void;
}

export interface SubscriptionsMenu {
  handles(data: string): boolean;
  onCallback(cb: { data: string; chatId: number }, ui: SubscriptionsMenuUi): Promise<void>;
}

/** Under a "cancelled?" line in a report. */
export function hideFromReportButton(e: RosterEntry): Button {
  return { text: `🙈 Hide ${label(e.displayName, 24)}`, callback_data: act('hr', e.handle) };
}

/** Under the "Renamed …" message the rename question ends on. */
export function undoRenameButton(handle: string): Button {
  return { text: '↩ Undo', callback_data: act('un', handle) };
}

export function findRosterEntry(roster: Roster, handle: string): RosterEntry | undefined {
  return [...roster.subscriptions, ...roster.bills, ...roster.maybes, ...roster.hidden].find((e) => e.handle === handle);
}

export function renderSubscriptionList(read: RosterRead, page: number): MenuScreen {
  const { roster } = read;
  const { entries, page: p, pages } = subscriptionListPage(roster, page);
  const rows: Button[][] = [];
  const link = roster.linkSuggestions[0];
  if (link) {
    const h = findingHandle(manualKey(link.manualId));
    rows.push([{ text: 'Yes', callback_data: act('ly', h) }, { text: 'No', callback_data: act('ln', h) }]);
  }
  for (const e of entries) rows.push([{ text: label(e.displayName), callback_data: act('d', e.handle) }]);
  if (pages > 1) {
    const nav: Button[] = [];
    if (p > 0) nav.push({ text: '‹ Prev', callback_data: `${LIST}${p - 1}` });
    if (p < pages - 1) nav.push({ text: 'Next ›', callback_data: `${LIST}${p + 1}` });
    rows.push(nav);
  }
  const footer: Button[] = [];
  const maybes = roster.maybes.length;
  if (maybes > 0) footer.push({ text: `❓ ${maybes} ${maybes === 1 ? 'maybe' : 'maybes'}`, callback_data: MAYBES });
  if (roster.hidden.length > 0) footer.push({ text: `🙈 ${roster.hidden.length} hidden`, callback_data: HIDDEN });
  footer.push({ text: '➕ Add', callback_data: askStartData('sub-add') });
  rows.push(footer);
  return { text: formatSubscriptionList(roster, p, { unreadable: read.unreadable }), keyboard: { inline_keyboard: rows } };
}

export function renderSubscriptionDetail(e: RosterEntry): MenuScreen {
  const name = escapeMarkdown(e.displayName);
  const amount = rosterAmount(e);
  const lines = [e.bankName ? `${name} — on your statement as ${escapeMarkdown(e.bankName)}` : name];
  lines.push(`${amount}${e.cadence === 'monthly' && amount !== 'no price yet' ? ' a month' : ''} · ${rosterWhen(e)}`);
  if (e.recent.length > 0) {
    lines.push(`Last charges: ${e.recent.map((r) => `${shortDate(r.date)} ${rosterMoney(r.cents)}`).join(' · ')}`);
  } else if (e.source === 'manual') {
    lines.push('No charge matched to it yet.');
  }
  if (e.creep) lines.push(`⬆ Up from ${rosterMoney(e.creep.fromCents)} to ${rosterMoney(e.creep.toCents)} on ${shortDate(e.creep.chargedOn)}.`);
  if (e.source === 'manual') lines.push('✍️ Added by you.');
  if (e.source === 'watched') lines.push('👀 Watching — you said this one recurs.');
  // A reminder counts down to a known charge date; without one it can never fire.
  const canRemind = e.nextDate !== null;
  if (canRemind) lines.push(`🔔 Remind: ${e.remind ? `${e.remind} ${e.remind === 1 ? 'day' : 'days'} before` : 'off'}`);
  else lines.push('Reminders start once a charge date is known.');
  const current = e.remind ?? 0;
  const remindRow: Button[] = canRemind ? ([1, 3, 7, 0] as const).map((n) => ({
    text: `${current === n ? '✓ ' : ''}${n === 0 ? 'Off' : `${n}d`}`,
    callback_data: act(`r${n}`, e.handle),
  })) : [];
  return {
    text: lines.join('\n'),
    keyboard: {
      inline_keyboard: [
        ...(remindRow.length > 0 ? [remindRow] : []),
        [{ text: '✏️ Rename', callback_data: askStartData('sub-rename', e.handle) }],
        [e.source === 'manual'
          ? { text: '🗑 Delete', callback_data: act('x', e.handle) }
          : { text: '🙈 Hide / I cancelled it', callback_data: act('h', e.handle) }],
        [BACK],
      ],
    },
  };
}

/** One maybe at a time, so each Yes/No pair has one subject. */
export function renderMaybe(roster: Roster): MenuScreen {
  const m = roster.maybes[0];
  if (!m) return { text: 'No maybes left — everything recurring is sorted.', keyboard: { inline_keyboard: [[BACK_TO_LIST]] } };
  const last = m.recent[0];
  const more = roster.maybes.length - 1;
  const lines = [
    `❓ Is ${escapeMarkdown(m.displayName)} a subscription?`,
    `${rosterAmount(m)} a month${last ? ` · last charged ${shortDate(last.date)}` : ''}`,
    ...(more > 0 ? [`_${more} more after this one._`] : []),
  ];
  return {
    text: lines.join('\n'),
    keyboard: {
      inline_keyboard: [
        [{ text: "✅ Yes, it's a subscription", callback_data: act('c', m.handle) }, { text: '🙈 No', callback_data: act('hm', m.handle) }],
        [BACK],
      ],
    },
  };
}

export function renderHidden(roster: Roster): MenuScreen {
  if (roster.hidden.length === 0) return { text: '🙈 Nothing is hidden.', keyboard: { inline_keyboard: [[BACK_TO_LIST]] } };
  const shown = roster.hidden.slice(0, 10);
  const lines = ['🙈 *Hidden* — tap one to put it back.', ...shown.map((e) => `${escapeMarkdown(e.displayName)} — ${rosterAmount(e)}`)];
  if (roster.hidden.length > shown.length) lines.push(`_${roster.hidden.length - shown.length} more — see the Subscriptions card in the app._`);
  return {
    text: lines.join('\n'),
    keyboard: { inline_keyboard: [...shown.map((e) => [{ text: `↩ ${label(e.displayName)}`, callback_data: act('u', e.handle) }]), [BACK]] },
  };
}

function doneScreen(text: string, undo: Button, extra: Button[] = []): MenuScreen {
  return { text, keyboard: { inline_keyboard: [[undo], [...extra, BACK_TO_LIST]] } };
}

export function createSubscriptionsMenu(deps: SubscriptionsMenuDeps): SubscriptionsMenu {
  return {
    handles(data) {
      return data.startsWith(SUBSCRIPTIONS_CALLBACK_PREFIX);
    },

    async onCallback(cb, ui) {
      try {
        const now = deps.now();
        let read: RosterRead;
        try {
          read = await deps.read(now);
        } catch (err) {
          deps.log(`Subscriptions menu: reading failed: ${message(err)}`);
          return void await ui.answer(SUBSCRIPTIONS_UNREACHABLE_REPLY);
        }
        const show = async (screen: MenuScreen, mode: 'edit' | 'send', toast?: string) => {
          if (mode === 'send') await ui.send(screen.text, screen.keyboard);
          else await ui.edit(screen.text, screen.keyboard);
          await ui.answer(toast);
        };
        const write = async (edit: SubscriptionEdit): Promise<boolean> => {
          try {
            await deps.edit(edit, now);
            return true;
          } catch (err) {
            if (isUnreadablePrefsError(err)) {
              await ui.answer(SUBSCRIPTIONS_UNREADABLE_REPLY);
            } else if (err instanceof SubscriptionPrefsInvalidError) {
              await ui.answer(SUBSCRIPTIONS_INVALID_REPLY);
            } else {
              deps.log(`Subscriptions menu: ${cb.data} write failed: ${message(err)}`);
              await ui.answer(SUBSCRIPTIONS_UNREACHABLE_REPLY);
            }
            return false;
          }
        };
        // After a SUCCESSFUL write a failed re-read must not read as a failure:
        // fall back to the pre-write roster (`read`), stale but honest.
        const reread = async (): Promise<RosterRead | null> => {
          try {
            return await deps.read(now);
          } catch (err) {
            deps.log(`Subscriptions menu: re-reading after ${cb.data} failed: ${message(err)}`);
            return null;
          }
        };
        const freshList = async () => renderSubscriptionList((await reread()) ?? read, 0);

        if (cb.data === OPEN_SUBSCRIPTIONS) return void await show(renderSubscriptionList(read, 0), 'send');
        if (cb.data.startsWith(LIST)) return void await show(renderSubscriptionList(read, Number(cb.data.slice(LIST.length)) || 0), 'edit');
        if (cb.data === MAYBES) return void await show(renderMaybe(read.roster), 'edit');
        if (cb.data === HIDDEN) return void await show(renderHidden(read.roster), 'edit');

        const m = cb.data.slice(SUBSCRIPTIONS_CALLBACK_PREFIX.length).match(ACTION);
        if (!m) return void await ui.answer();
        const [, action, handle] = m;
        // A report's button: whatever it shows goes out as a NEW message.
        const mode = action === 'hr' ? 'send' : 'edit';
        const gone = () => show(renderSubscriptionList(read, 0), mode, SUBSCRIPTIONS_GONE_ANSWER);
        const { roster, prefs } = read;
        const active = [...roster.subscriptions, ...roster.bills].find((e) => e.handle === handle);
        const anywhere = findRosterEntry(roster, handle);

        switch (action) {
          case 'd':
            return void await (active ? show(renderSubscriptionDetail(active), 'edit') : gone());
          case 'r0': case 'r1': case 'r3': case 'r7': {
            if (!active) return void await gone();
            const days = Number(action.slice(1)) as 0 | RemindDays;
            if (!(await write((p) => setRemind(p, active.key, days === 0 ? null : days)))) return;
            const after = await reread();
            const fresh = after
              ? findRosterEntry(after.roster, handle) ?? active
              : { ...active, remind: days === 0 ? undefined : days };
            return void await show(renderSubscriptionDetail(fresh), 'edit',
              days === 0 ? 'Reminder off' : `Reminder: ${days} ${days === 1 ? 'day' : 'days'} before`);
          }
          case 'h': case 'hr': {
            if (!active) return void await gone();
            if (!(await write((p) => hideKey(p, active.key)))) return;
            return void await show(doneScreen(
              `🙈 Hid ${escapeMarkdown(active.displayName)}. It's out of every total and report — Undo puts it back.`,
              { text: '↩ Undo', callback_data: act('uh', handle) },
            ), mode);
          }
          case 'c': case 'hm': {
            const maybe = roster.maybes.find((e) => e.handle === handle);
            if (!maybe) return void await gone();
            const yes = action === 'c';
            if (!(await write((p) => (yes ? confirmKey(p, maybe.key) : hideKey(p, maybe.key))))) return;
            const name = escapeMarkdown(maybe.displayName);
            return void await show(doneScreen(
              yes ? `✅ ${name} now counts as a subscription.` : `🙈 Okay — ${name} isn't a subscription.`,
              { text: '↩ Undo', callback_data: act(yes ? 'uc' : 'uh', handle) },
              roster.maybes.length > 1 ? [{ text: 'Next maybe ›', callback_data: MAYBES }] : [],
            ), 'edit');
          }
          case 'x': {
            if (!active || active.source !== 'manual') return void await gone();
            const id = active.key.slice(2);
            if (!(await write((p) => deleteManual(p, id, now)))) return;
            return void await show(doneScreen(`🗑 Deleted ${escapeMarkdown(active.displayName)}.`, { text: '↩ Undo', callback_data: act('ux', handle) }), 'edit');
          }
          case 'u': case 'uh': {
            const entry = roster.hidden.find((e) => e.handle === handle);
            if (!entry) return void await gone();
            // With its aliases: a renamed charge's key hides the entry it was joined into (F1).
            if (!(await write((p) => unhideEntry(p, entry)))) return;
            if (action === 'u') return void await show(renderHidden(((await reread()) ?? read).roster), 'edit', `Restored ${entry.displayName}`);
            return void await show(await freshList(), 'edit', 'Undone');
          }
          case 'uc': {
            // The Yes may be stored under a pre-1.63 key (R6).
            if (!anywhere || !prefs.confirmed.some((k) => normalizeRosterKey(k) === normalizeRosterKey(anywhere.key))) return void await gone();
            if (!(await write((p) => unconfirmKey(p, anywhere.key)))) return;
            return void await show(await freshList(), 'edit', 'Undone');
          }
          case 'un': {
            if (!anywhere || !(anywhere.key in prefs.prevNames)) return void await gone();
            if (!(await write((p) => undoRename(p, anywhere.key)))) return;
            return void await show(await freshList(), 'edit', 'Undone');
          }
          case 'ux': {
            const deleted = prefs.deleted.find((d) => findingHandle(manualKey(d.id)) === handle);
            if (!deleted) return void await gone();
            if (!(await write((p) => restoreDeleted(p, deleted.id)))) return;
            return void await show(await freshList(), 'edit', 'Undone');
          }
          case 'ly': case 'ln': {
            const s = roster.linkSuggestions.find((l) => findingHandle(manualKey(l.manualId)) === handle);
            if (!s) return void await gone();
            const yes = action === 'ly';
            if (!(await write((p) => (yes ? acceptLink(p, s) : declineLink(p, s.manualId, s.merchant))))) return;
            return void await show(await freshList(), 'edit', yes ? `Linked to ${s.manualName}` : "Okay — I won't suggest that one again");
          }
          default:
            return void await ui.answer();
        }
      } catch (err) {
        deps.log(`Subscriptions menu: ${cb.data} failed: ${message(err)}`);
        await ui.answer(FAILED_ANSWER).catch(() => {});
      }
    },
  };
}
