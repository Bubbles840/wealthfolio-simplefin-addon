import { describe, it, expect } from 'vitest';
import { parseCommand, formatHelpReply, TELEGRAM_COMMAND_MENU } from './telegram-commands';

describe('parseCommand', () => {
  it('parses a bare command', () => {
    expect(parseCommand('/report')).toEqual({ command: 'report', args: '' });
  });
  it('parses arguments as one trimmed string', () => {
    expect(parseCommand('/afford  20 shopping ')).toEqual({ command: 'afford', args: '20 shopping' });
  });
  it('strips an @BotName suffix, which Telegram appends in groups', () => {
    expect(parseCommand('/left@SimplefinSyncBot groceries')).toEqual({ command: 'left', args: 'groceries' });
  });
  it('lowercases the command but never the arguments', () => {
    expect(parseCommand('/LEFT Groceries')).toEqual({ command: 'left', args: 'Groceries' });
  });
  it('returns null for plain text, empty, and null', () => {
    expect(parseCommand('what is left?')).toBeNull();
    expect(parseCommand('')).toBeNull();
    expect(parseCommand(null)).toBeNull();
  });
  it('returns null for a lone slash', () => {
    expect(parseCommand('/')).toBeNull();
  });
});

describe('formatHelpReply', () => {
  it('lists every command in the menu, one line each', () => {
    const help = formatHelpReply();
    for (const { command } of TELEGRAM_COMMAND_MENU) {
      expect(help).toContain(`/${command}`);
    }
  });
  it('menu covers exactly the six shipped commands', () => {
    expect(TELEGRAM_COMMAND_MENU.map((c) => c.command).sort())
      .toEqual(['afford', 'help', 'left', 'report', 'status', 'sync']);
  });
  it('prefixes with Unknown command when asked about junk', () => {
    const help = formatHelpReply('bogus');
    expect(help).toMatch(/^Unknown command/);
    expect(help).toContain('/bogus');
  });
});
