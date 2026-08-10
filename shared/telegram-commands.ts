/**
 * shared/telegram-commands.ts
 *
 * Parsing and reply formatting for the bot's slash commands. Pure functions —
 * data in, string out — beside the report formatters in ./telegram.ts and for
 * the same reason: the companion owns transport and storage, and everything
 * testable without a network lives here.
 */

export interface ParsedCommand {
  /** Lowercased, without the slash: 'report', 'left', … */
  command: string;
  /** Everything after the command, trimmed. Case preserved — category names matter. */
  args: string;
}

/** `/cmd`, `/cmd args`, `/cmd@BotName args` — Telegram appends the bot name in groups. */
export function parseCommand(text: string | null | undefined, botName?: string): ParsedCommand | null {
  const t = (text ?? '').trim();
  if (!t.startsWith('/') || t.length < 2) return null;
  const [head, ...rest] = t.split(/\s+/);
  let name = head.slice(1);
  const at = name.indexOf('@');
  if (at !== -1) {
    // Addressed to a specific bot. If it names a DIFFERENT bot, this message is
    // not for us — treat as non-command rather than answering someone else's mail.
    const addressed = name.slice(at + 1);
    if (botName && addressed.toLowerCase() !== botName.toLowerCase()) return null;
    name = name.slice(0, at);
  }
  if (!name) return null;
  return { command: name.toLowerCase(), args: rest.join(' ').trim() };
}

/** Registered via setMyCommands so Telegram's ☰ menu lists them. Order is display order. */
export const TELEGRAM_COMMAND_MENU = [
  { command: 'report', description: "Today's spending digest, fresh from the database" },
  { command: 'left', description: "What's left per category — /left groceries narrows it" },
  { command: 'afford', description: 'Can I afford it? — /afford 20 shopping' },
  { command: 'status', description: 'Last sync, balances, what needs attention' },
  { command: 'sync', description: 'Pull new bank transactions now' },
  { command: 'help', description: 'This list' },
] as const;

export function formatHelpReply(unknownCommand?: string): string {
  const lines = TELEGRAM_COMMAND_MENU.map((c) => `/${c.command} — ${c.description}`);
  const head = unknownCommand ? `Unknown command: /${unknownCommand}\n\n` : '';
  return `${head}${lines.join('\n')}`;
}
