/**
 * companion/src/transfer-learning.ts
 *
 * "This one is a transfer" — one tap, and every future one is typed correctly.
 *
 * The alternative was a keyword list, and a keyword list cannot win. Every
 * issuer words a card payment differently: the case that prompted this was
 * "Payment to Ccb Credit Card Payments", where `Ccb` is Coastal Community Bank
 * — the Robinhood card's issuer, a string no list would ever have contained.
 * v1.18.1 widened the built-in patterns for the phrasings that ARE
 * unambiguous; this is the answer for the ones that are not.
 *
 * It writes a MAPPING RULE rather than just retyping the row, because the rule
 * is what makes it permanent — and because the sync already updates rows whose
 * resolved type differs from what is stored, so the next run also retypes the
 * transaction that prompted the tap. One action fixes the past and the future.
 *
 * Rules always win over the built-in keywords (`matchRule` runs first in
 * `mapTransactionWithSource`), so a rule written here cannot be overruled by a
 * later change to those patterns.
 */
import type { InlineKeyboard } from '../../shared/telegram.js';
import { MENU_CALLBACK_PREFIX } from '../../shared/categorize-menu.js';
import type { MappingRule, ActivityType } from '../../shared/types.js';

const OPEN_PREFIX = `${MENU_CALLBACK_PREFIX}tl:`;
const CHOOSE_PREFIX = `${MENU_CALLBACK_PREFIX}tlc:`;

/** Transactions offered per notice. The picker is a list of buttons in a chat
 *  message, not a table. */
const MAX_CANDIDATES = 8;
const MAX_SESSIONS = 30;

/** Types that are already a transfer, so there is nothing to teach. */
const ALREADY_TRANSFER = new Set(['TRANSFER_IN', 'TRANSFER_OUT']);

export interface TransferCandidate {
  /** Display text, already stripped of the tx id (`ImportNoticeTx.description`). */
  description: string;
  amountCents: number;
  /** As imported. `WITHDRAWAL` becomes `TRANSFER_OUT`, `DEPOSIT` becomes
   *  `TRANSFER_IN` — the direction is not guessed, it is preserved. */
  activityType: string;
  accountName: string;
}

export interface TransferLearningDeps {
  readRules(): Promise<MappingRule[]>;
  /** MUST merge: the addon's Transaction Rules card owns this list. */
  writeRules(rules: MappingRule[]): Promise<void>;
  log(msg: string): void;
}

export interface TransferLearningUi {
  edit(text: string, keyboard?: InlineKeyboard): Promise<void>;
  answer(text?: string): Promise<void>;
}

export interface TransferLearning {
  /** The single entry button for a notice, or undefined when nothing in the
   *  run could be a transfer. */
  entryButton(candidates: TransferCandidate[]): InlineKeyboard['inline_keyboard'][number] | undefined;
  handles(data: string): boolean;
  onCallback(cb: { data: string }, ui: TransferLearningUi): Promise<void>;
}

/**
 * The rule pattern for a description.
 *
 * A bank repeats the payee wording verbatim between payments but appends
 * varying reference numbers and dates, so the pattern is the leading run of
 * WORDS — letters, digits and spaces — with trailing digit-only tokens
 * dropped. "Payment to Ccb Credit Card Payments" survives whole; "ACH
 * WITHDRAWAL 0821 REF 99182" becomes "ACH WITHDRAWAL", which still identifies
 * the payee without pinning the rule to one day's reference.
 */
export function rulePatternFor(description: string): string {
  const cleaned = description.replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const words = cleaned.split(' ');
  while (words.length > 1 && /^\d+$/.test(words[words.length - 1])) words.pop();
  // Capped so one long descriptor does not become a rule so specific that the
  // next payment fails to match it.
  return words.slice(0, 6).join(' ');
}

export function createTransferLearning(deps: TransferLearningDeps): TransferLearning {
  const sessions = new Map<string, TransferCandidate[]>();
  let counter = 0;

  const eligible = (candidates: TransferCandidate[]) =>
    candidates
      .filter((c) => !ALREADY_TRANSFER.has(String(c.activityType).toUpperCase()))
      .filter((c) => rulePatternFor(c.description).length > 0)
      .slice(0, MAX_CANDIDATES);

  return {
    entryButton(candidates) {
      const list = eligible(candidates);
      if (list.length === 0) return undefined;
      const token = String(++counter);
      sessions.set(token, list);
      while (sessions.size > MAX_SESSIONS) {
        const oldest = sessions.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
      return [{ text: '↔ Mark one as a transfer', callback_data: `${OPEN_PREFIX}${token}` }];
    },

    handles(data) {
      return data.startsWith(OPEN_PREFIX) || data.startsWith(CHOOSE_PREFIX);
    },

    async onCallback(cb, ui) {
      try {
        if (cb.data.startsWith(OPEN_PREFIX)) {
          const list = sessions.get(cb.data.slice(OPEN_PREFIX.length));
          if (!list) return void await ui.answer('That menu expired — use Transaction Rules in the addon.');
          const token = cb.data.slice(OPEN_PREFIX.length);
          await ui.edit(
            'Which of these is a transfer between your own accounts?\n\n'
            + '_Money moved, not money spent — a card payment, or a move to savings._',
            {
              inline_keyboard: list.map((c, i) => [{
                text: `${c.description.slice(0, 30)} · $${(c.amountCents / 100).toFixed(2)}`,
                callback_data: `${CHOOSE_PREFIX}${token}:${i}`,
              }]),
            },
          );
          await ui.answer();
          return;
        }

        const rest = cb.data.slice(CHOOSE_PREFIX.length);
        const sep = rest.lastIndexOf(':');
        const list = sessions.get(sep === -1 ? rest : rest.slice(0, sep));
        const chosen = list?.[sep === -1 ? NaN : Number(rest.slice(sep + 1))];
        if (!chosen) return void await ui.answer('That menu expired — use Transaction Rules in the addon.');

        const pattern = rulePatternFor(chosen.description);
        // Direction preserved from how it imported, never guessed: money out is
        // a transfer out, money in a transfer in.
        const activityType: ActivityType =
          String(chosen.activityType).toUpperCase() === 'DEPOSIT' ? 'TRANSFER_IN' : 'TRANSFER_OUT';

        const rules = await deps.readRules();
        const already = rules.some(
          (r) => r.pattern.toLowerCase() === pattern.toLowerCase() && r.activityType === activityType,
        );
        if (!already) {
          // Appended, never replacing: the user's own rules live in this list,
          // and earlier rules keep their precedence.
          await deps.writeRules([...rules, { pattern, matchType: 'contains', activityType }]);
        }

        await ui.edit(
          `↔ *${pattern}* → ${activityType === 'TRANSFER_IN' ? 'transfer in' : 'transfer out'}\n\n`
          + (already ? 'That rule already existed.\n\n' : '')
          + 'The next sync retypes this transaction and every future one matching it, '
          + 'so it stops counting as spending. Edit or remove it under '
          + 'Advanced → Transaction Rules.',
        );
        await ui.answer('Rule saved');
      } catch (err) {
        deps.log(`Transfer-learning menu error: ${String(err)}`);
        await ui.answer('Could not save that — try Transaction Rules in the addon.').catch(() => {});
      }
    },
  };
}
