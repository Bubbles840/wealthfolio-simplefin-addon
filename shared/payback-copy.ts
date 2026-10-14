/**
 * shared/payback-copy.ts
 *
 * Every sentence the payback feature says (1.62.0, W6–W10), in one place:
 * Telegram's /categorize, the change log's Undo and Redo, and "Make every …
 * deposit a payback". RAW text: bank, account and category names go in as
 * they are, and Telegram escapes the whole message when it renders it, outside
 * any bold or italic — no sentence here uses Markdown. A leaf module, so the
 * planner, the filing runner and the change log's runner can share it without
 * importing one another.
 */
import { money } from './telegram.js';

// ── The menu ─────────────────────────────────────────────────────────────
/** The switch on a deposit's category screen (it read "Spending categories »"). */
export const PAYBACK_SWITCH = "It's a payback »";
/** The line over the payback grid. */
export const PAYBACK_PICK = 'Pick the spending it pays you back for.';

// ── Filing ───────────────────────────────────────────────────────────────
/** "Filed as a payback under Restaurants — it takes $14 off your Food & Dining spending." */
export function paybackDone(categoryName: string, spendingName: string, absCents: number): string {
  return `Filed as a payback under ${categoryName} — it takes ${money(absCents / 100)} off your ${spendingName} spending.`;
}
export const PAYBACK_UNDO_HINT = 'Undo it from /changes.';
export const PAYBACK_NO_UNDO = "The change log couldn't be written, so there's no Undo for it.";
export const paybackUnfiled = (categoryName: string): string =>
  `It's a payback now, but Wealthfolio didn't file it under ${categoryName} — /categorize offers it again.`;

export const PAYBACK_GONE = 'That transaction is gone — nothing was changed.';
export const PAYBACK_MANAGED = "The sync manages this row (a held transfer, a starting balance or a correction), so it can't be a payback.";
export const PAYBACK_NOT_FEED = 'Only a transaction from your bank feed can be a payback here — nothing was changed.';
export const PAYBACK_LINKED = "It's half of a linked transfer, so it can't be a payback — nothing was changed.";
export const PAYBACK_TRANSFER = "It's recorded as a transfer, so it can't be a payback — nothing was changed.";
export const PAYBACK_PENDING = "It's still pending — file it as a payback once it posts.";
export const PAYBACK_NOT_CASH = 'Only money into a bank account can be a payback — on a card, Wealthfolio already takes a credit off spending.';
export const PAYBACK_ALREADY = "It's already a payback — nothing was changed.";
export const PAYBACK_NOT_DEPOSIT = 'Only a deposit can be a payback — nothing was changed.';
/** Telegram, while the installed add-on is older than PAYBACK_SINCE or unknown (W8). */
export const PAYBACK_UPDATE_ADDON = "Update the add-on to 1.62.0 or newer first — an older one turns a payback back into a deposit on its next sync. Nothing was changed; once it's updated, paybacks show in the app's Change log too.";
export const PAYBACK_UNREACHABLE = "Couldn't reach Wealthfolio — nothing was changed.";
export const PAYBACK_RUNNING = 'Already being filed — try again in a moment.';
export const PAYBACK_UNAVAILABLE = "Paybacks aren't available here — nothing was changed.";

export const PAYBACK_OVERRIDE_FAILED = "Couldn't save the payback setting — nothing was changed.";
export const PAYBACK_UPDATE_REFUSED = "Wealthfolio didn't take the change, so it's still a deposit — nothing was changed.";
export const PAYBACK_UPDATE_STUCK = "Wealthfolio didn't take the change, so it's still a deposit — but the payback setting couldn't be taken back, so the next sync makes it a payback with no category, and /categorize offers it then.";
export const PAYBACK_UPDATE_UNSURE = "Couldn't tell whether Wealthfolio took the change. The payback setting stays, so the next sync makes it a payback; if it has no category then, /categorize offers it.";

// ── Undo and Redo ────────────────────────────────────────────────────────
export const paybackUndone = (categoryName: string | null): string =>
  `Undone — it's a deposit again${categoryName ? `, off ${categoryName}` : ''}.`;
export const paybackRedone = (categoryName: string | null): string =>
  `Redone — it's a payback${categoryName ? ` under ${categoryName}` : ''} again.`;
export const PAYBACK_UNDO_UNCHANGED = "Couldn't undo it — Wealthfolio didn't take the change. It's still a payback, and nothing was changed.";
export const PAYBACK_UNDO_STUCK = "Couldn't undo it — Wealthfolio didn't take the change, and the payback setting couldn't be put back, so the next sync turns it into a deposit that is still filed under its category. Take that off in Wealthfolio then.";
export const paybackUndoHalf = (categoryName: string): string =>
  `Couldn't finish the undo — it's a deposit again, but it's still filed under ${categoryName}. Take that off in Wealthfolio.`;
export const PAYBACK_REDO_UNCHANGED = "Couldn't redo it — Wealthfolio didn't take the change. It's still a deposit, and nothing was changed.";
export const PAYBACK_REDO_STUCK = "Couldn't redo it — Wealthfolio didn't take the change, and the payback setting couldn't be taken back, so the next sync makes it a payback with no category, and /categorize offers it then.";
export const paybackRedoHalf = (categoryName: string): string =>
  `Couldn't finish the redo — it's a payback again, but Wealthfolio didn't file it under ${categoryName}; /categorize offers it.`;

// ── "Make every … deposit a payback" (W10) ───────────────────────────────
export const paybackRulesButton = (pattern: string): string => `Make every ${pattern} deposit a payback`;
export function paybackRulesPreview(pattern: string, accountName: string, categoryName: string, catches: number): string {
  return [
    `Make every ${pattern} deposit a payback?`,
    `Money into ${accountName} whose description contains "${pattern}" becomes a payback under ${categoryName}: `
      + 'the sync marks it when it imports, and Wealthfolio files it. Undo either rule from /changes.',
    catches > 0
      ? `Right now that also catches ${catches} other deposit${catches === 1 ? '' : 's'} waiting for a category.`
      : 'Nothing else waiting for a category matches right now.',
  ].join('\n');
}
export const PAYBACK_RULES_CREATE = 'Create both rules';
export const paybackRulesDone = (pattern: string, accountName: string, categoryName: string): string =>
  `Done — every ${pattern} deposit into ${accountName} is a payback under ${categoryName} from now on. Undo either rule from /changes.`;
export const PAYBACK_RULES_EXIST = 'Both rules are already there — nothing was added.';
export const PAYBACK_RULES_SAVE_FAILED = "Couldn't save the transaction rule — nothing was changed.";
export const PAYBACK_RULES_REFUSED = "Wealthfolio didn't take the category rule, so neither rule was made.";
export const paybackRulesStuck = (pattern: string): string =>
  `Wealthfolio didn't take the category rule, and the transaction rule couldn't be taken back — new ${pattern} deposits become paybacks with no category. Undo the transaction rule from /changes.`;
