import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * 1.57 folded five tabs into three (Home, Reports, Settings). Text that sends
 * someone to "Advanced → Accounts" or "the Notifications tab" now points at
 * something that does not exist — worst in a Telegram message, where there is
 * no button to follow instead. Comments may keep the history; copy may not.
 */
const REMOVED = [/Advanced →/, /Notifications tab/, /Budget tab/, /Overview tab/];
const ROOTS = ['src', 'shared', 'companion/src'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** A line that is (the start of) a comment rather than copy. */
const isComment = (line: string) => /^(\/\/|\*|\/\*|\{\/\*)/.test(line.trim());

describe('copy names only the tabs that exist', () => {
  it('never points the user at a tab removed in 1.57', () => {
    const offenders: string[] = [];
    for (const file of ROOTS.flatMap((r) => sourceFiles(join(process.cwd(), r)))) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!isComment(line) && REMOVED.some((re) => re.test(line))) {
          offenders.push(`${file.slice(process.cwd().length + 1)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
