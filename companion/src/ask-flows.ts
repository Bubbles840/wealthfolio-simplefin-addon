/**
 * companion/src/ask-flows.ts
 *
 * The bot's question flows. Pure builders — the data they need (categories,
 * counts, budget rows) is passed in — so each can be driven through the shared
 * engine in a test without a database. index.ts registers them and owns what
 * happens on Save.
 *
 * The engine never escapes; anything user- or bank-supplied that a prompt or
 * summary prints goes through `escapeMarkdown` here.
 */
import type { AskFlow } from '../../shared/ask-flow.js';
import { formatDollars, shortDate } from '../../shared/telegram.js';
import { nextOccurrence, parseAmountCents, parseDateInput } from '../../shared/telegram-commands.js';

const AMOUNT_HINT = "Couldn't read that as an amount — try 16000 or $16,000.";
const DATE_HINT = "Couldn't read that date — try Dec 12 or 2026-12-12.";

export function buildPoolSetFlow(now: Date): AskFlow {
  const today = now.toISOString().slice(0, 10);
  return {
    id: 'pool-set',
    command: 'pool',
    title: 'Semester pool',
    steps: [
      {
        id: 'amount',
        kind: 'text',
        prompt: () => 'How much is the pool? (e.g. 16000)',
        parse: (input) => {
          const cents = parseAmountCents(input);
          return cents === null ? { ok: false, hint: AMOUNT_HINT } : { ok: true, value: cents };
        },
      },
      {
        id: 'until',
        kind: 'text',
        prompt: (a) => `${formatDollars((a.amount as number) / 100, 0)} has to last until when? (e.g. Dec 12)`,
        parse: (input) => {
          const date = parseDateInput(input, now);
          if (date === null) return { ok: false, hint: DATE_HINT };
          if (date.form === 'iso' && date.iso < today) return { ok: false, hint: 'That date has passed — pick one ahead of today.' };
          return { ok: true, value: date.form === 'month-day' ? nextOccurrence(date.iso, today) : date.iso };
        },
      },
    ],
    summary: (a) => `*${formatDollars((a.amount as number) / 100, 0)}* from today until *${shortDate(a.until as string)}*.`,
  };
}

export function buildPoolClearFlow(): AskFlow {
  return {
    id: 'pool-clear',
    command: 'pool',
    title: 'Clear the pool',
    steps: [{
      id: 'confirm',
      kind: 'choice',
      prompt: () => 'Clear the pool? Reports go back to budgets only.',
      options: () => [{ label: 'Yes, clear', value: true }],
    }],
  };
}
