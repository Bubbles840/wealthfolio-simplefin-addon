/**
 * companion/src/findings-menu.ts
 *
 * The "🧹 Show what to fix" button under the morning report, and the screens
 * behind it: the full list, one screen per finding, and the actions — fix it
 * (where a fix exists) or snooze it.
 *
 * STATELESS ON PURPOSE. The report goes out at 8am and the tap can come at
 * noon, after a container restart. Every screen re-judges the findings from
 * the database at tap time and finds the one tapped by a hash of its key, so
 * there is no session to expire and no snapshot to go stale: a finding fixed
 * in the meantime is simply gone from the list, which is the truth.
 *
 * The fixes themselves are hand-offs to flows that already exist and already
 * preview before writing (transfer-learning's rule confirmation, the category
 * picker). Nothing here writes to the ledger directly.
 */
import { MENU_CALLBACK_PREFIX } from '../../shared/categorize-menu.js';
import type { InlineKeyboard } from '../../shared/telegram.js';
import { escapeFindingText, type FindingFix, type SelfCheckFinding } from '../../shared/self-check.js';
import { findingHandle, findingLabel, formatFindingsList, isSnoozable, SNOOZE_DAYS } from '../../shared/findings.js';
import type { GatheredFindings } from './daily-findings.js';

export const FINDINGS_CALLBACK_PREFIX = `${MENU_CALLBACK_PREFIX}fx:`;
/** From the report: the list as a NEW message. Editing would draw the menu
 *  over the report, the only copy of the morning's numbers in the chat. */
const OPEN = `${FINDINGS_CALLBACK_PREFIX}o`;
/** The list, edited in place (Back, Refresh). */
const LIST = `${FINDINGS_CALLBACK_PREFIX}l`;
const DETAIL = `${FINDINGS_CALLBACK_PREFIX}d:`;
const SNOOZE = `${FINDINGS_CALLBACK_PREFIX}s:`;
const FIX = `${FINDINGS_CALLBACK_PREFIX}f:`;
const UNSNOOZE_ALL = `${FINDINGS_CALLBACK_PREFIX}u`;

/** The one button the morning report carries when anything is folded. */
export const SHOW_FINDINGS_BUTTON = { text: '🧹 Show what to fix', callback_data: OPEN };

const GONE_ANSWER = 'That one is already sorted — refreshing.';

export interface FindingsMenuUi {
  edit(text: string, keyboard?: InlineKeyboard): Promise<void>;
  answer(text?: string): Promise<void>;
  send(text: string, keyboard?: InlineKeyboard): Promise<void>;
}

export interface FindingsMenuDeps {
  /** Re-judged on every tap, never cached. MUST NOT record "first seen" for
   *  the ledger audit — only the scheduled report does that. */
  current(now: Date): Promise<GatheredFindings>;
  snooze(key: string, now: Date): Promise<void>;
  unsnoozeAll(now: Date): Promise<void>;
  /** Hands the message over to the transfer-rule confirmation. */
  makeTransfer(fix: Extract<FindingFix, { kind: 'make-transfer' }>, ui: FindingsMenuUi): Promise<void>;
  /** Opens the category picker on one transaction, as a new message. */
  pickCategory(activityId: string, chatId: number, ui: FindingsMenuUi): Promise<void>;
  now(): Date;
  log(msg: string): void;
}

const FIX_BUTTON_TEXT: Record<FindingFix['kind'], string> = {
  'make-transfer': '↔ Make it a transfer',
  'pick-category': '🏷 Pick a category',
};

/** Only these get a row of their own: a finding with nothing to do and no
 *  way to snooze it (a failing sync) is already said in full in the text. */
const actionable = (f: SelfCheckFinding) => !!f.key && (isSnoozable(f) || !!f.fix);

export function renderFindingsList(found: GatheredFindings): { text: string; keyboard: InlineKeyboard } {
  const text = formatFindingsList(found.visible, { snoozedCount: found.snoozed.length });
  const rows: InlineKeyboard['inline_keyboard'] = [];
  found.visible.forEach((f, i) => {
    if (!actionable(f)) return;
    rows.push([{ text: `${i + 1}. ${findingLabel(f, 36)}`, callback_data: `${DETAIL}${findingHandle(f.key!)}` }]);
  });
  const footer = [{ text: '🔄 Refresh', callback_data: LIST }];
  if (found.snoozed.length > 0) {
    footer.push({ text: `↩ Unsnooze ${found.snoozed.length}`, callback_data: UNSNOOZE_ALL });
  }
  rows.push(footer);
  return { text, keyboard: { inline_keyboard: rows } };
}

export function renderFindingDetail(f: SelfCheckFinding): { text: string; keyboard: InlineKeyboard } {
  const rows: InlineKeyboard['inline_keyboard'] = [];
  const handle = findingHandle(f.key ?? '');
  if (f.fix) rows.push([{ text: FIX_BUTTON_TEXT[f.fix.kind], callback_data: `${FIX}${handle}` }]);
  if (isSnoozable(f)) rows.push([{ text: `💤 Snooze ${SNOOZE_DAYS} days`, callback_data: `${SNOOZE}${handle}` }]);
  rows.push([{ text: '‹ Back', callback_data: LIST }]);
  const glyph = f.severity === 'problem' ? '🚨' : '⚠️';
  const hint = f.fix
    ? ''
    : isSnoozable(f)
      ? '\n\n_Nothing here can fix this one for you. Snooze it if you already know._'
      : '';
  return { text: `${glyph} ${escapeFindingText(f.message)}${hint}`, keyboard: { inline_keyboard: rows } };
}

export interface FindingsMenu {
  handles(data: string): boolean;
  onCallback(cb: { data: string; chatId: number }, ui: FindingsMenuUi): Promise<void>;
}

export function createFindingsMenu(deps: FindingsMenuDeps): FindingsMenu {
  const byHandle = (found: GatheredFindings, handle: string) =>
    found.visible.find((f) => f.key && findingHandle(f.key) === handle);

  async function showList(ui: FindingsMenuUi, mode: 'edit' | 'send', toast?: string): Promise<void> {
    const { text, keyboard } = renderFindingsList(await deps.current(deps.now()));
    if (mode === 'send') await ui.send(text, keyboard);
    else await ui.edit(text, keyboard);
    await ui.answer(toast);
  }

  return {
    handles(data) {
      return data.startsWith(FINDINGS_CALLBACK_PREFIX);
    },

    async onCallback(cb, ui) {
      try {
        if (cb.data === OPEN) return void await showList(ui, 'send');
        if (cb.data === LIST) return void await showList(ui, 'edit');
        if (cb.data === UNSNOOZE_ALL) {
          await deps.unsnoozeAll(deps.now());
          return void await showList(ui, 'edit', 'Snoozes cleared');
        }

        const [prefix, handle] = [DETAIL, SNOOZE, FIX]
          .filter((p) => cb.data.startsWith(p))
          .map((p) => [p, cb.data.slice(p.length)] as const)[0] ?? [null, ''];
        if (!prefix) return void await ui.answer();

        const found = await deps.current(deps.now());
        const finding = byHandle(found, handle);
        if (!finding) return void await showList(ui, 'edit', GONE_ANSWER);

        if (prefix === DETAIL) {
          const { text, keyboard } = renderFindingDetail(finding);
          await ui.edit(text, keyboard);
          return void await ui.answer();
        }
        if (prefix === SNOOZE) {
          if (!isSnoozable(finding)) return void await ui.answer('That one cannot be snoozed');
          await deps.snooze(finding.key!, deps.now());
          return void await showList(ui, 'edit', `Snoozed for ${SNOOZE_DAYS} days`);
        }
        // FIX
        const fix = finding.fix;
        if (!fix) return void await ui.answer();
        if (fix.kind === 'make-transfer') return void await deps.makeTransfer(fix, ui);
        await deps.pickCategory(fix.activityId, cb.chatId, ui);
        await ui.answer();
      } catch (err) {
        deps.log(`Findings menu: ${cb.data} failed: ${err instanceof Error ? err.message : String(err)}`);
        await ui.answer('Could not do that — check the companion logs.').catch(() => {});
      }
    },
  };
}
