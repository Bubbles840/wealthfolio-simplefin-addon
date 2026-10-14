import { describe, it, expect, vi } from 'vitest';
import {
  bookkeepingChange, categoryFiledChange, importChange, stampChange, transferLinkChange, type ChangeDraft,
} from '../../shared/change-entries.js';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log.js';
import { findingHandle } from '../../shared/handle.js';
import {
  changesData, CHANGES_GONE_ANSWER, CHANGES_UNREACHABLE_REPLY, createChangesMenu, normalizeChangesQuery,
  parseChangesData, renderChangeDetail, renderChangesCommand, renderChangesList, type MenuScreen,
} from './changes-menu.js';

/** Local wall-clock moments: the list's clock and day headings are local. */
const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m);
const NOW = at(12, 15, 0);
const CHECKING = { sfinId: 'ACT-1f2e', wfId: 'wf-checking', name: 'Checking' };
const item = (draft: ChangeDraft, when: Date, run?: string): ChangeLogItem => stampChange(draft, 'companion', when, run);
const imp = (n: number, when: Date, run?: string, description = `KROGER #${n}`) => item(importChange({
  account: CHECKING, txKey: `k${n}`, activityId: `act-${n}`, description, amountCents: -1234, date: '2026-10-11',
  pending: false, activityType: 'WITHDRAWAL',
}), when, run);
const filed = (desc: string, when: Date, account = CHECKING) => item(categoryFiledChange({
  actor: 'you', account, activityId: `f-${desc}`, description: desc, amountCents: -650,
  before: null, after: { categoryId: 'cat-din', categoryName: 'Dining' },
}), when);
const background = (when: Date) => item(bookkeepingChange({ step: 'external-marker', account: CHECKING, activityIds: ['x'] }), when);
const log = (entries: ChangeLogItem[], extra: Partial<ChangeLogRead> = {}): ChangeLogRead =>
  ({ entries: [...entries].sort((a, b) => (a.at < b.at ? 1 : -1)), gaps: [], trimmed: 0, unreadable: [], ...extra });

const allData = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
const button = (s: MenuScreen, text: string) => {
  const b = s.keyboard.inline_keyboard.flat().find((x) => x.text === text);
  if (!b) throw new Error(`no "${text}" among ${s.keyboard.inline_keyboard.flat().map((x) => x.text).join(' | ')}`);
  return b.callback_data;
};

describe('an entry opened from a /why story (1.61)', () => {
  const ID = '0f8fad5b-d9cb-469f-a165-708677289501';
  it('carries the story as its back, inside 64 bytes, and Back returns to the story in place', () => {
    const entry = imp(1, at(12, 9, 0));
    const data = changesData({ kind: 'detail', entry: 'abcd1234', back: { kind: 'why', activityId: ID } });
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseChangesData(data)).toEqual({ kind: 'detail', entry: 'abcd1234', back: { kind: 'why', activityId: ID } });
    const s = renderChangeDetail(entry, { kind: 'why', activityId: ID });
    expect(button(s, '‹ Back')).toBe(`cz:wy:t${ID}:c`);
  });

  it('is only ever a back, never a screen of its own', () => {
    expect(parseChangesData(`cz:cl:w${'x'.repeat(36)}`)).toBeNull();
  });
});

describe('the /changes list', () => {
  it('shows the last 7 days newest first, by day, numbered, a run as one row, background behind a button', () => {
    const read = log([
      imp(1, at(12, 14, 5), 'runA'), imp(2, at(12, 14, 5), 'runA'),
      background(at(12, 14, 5)),
      filed('VENMO *J SMITH', at(11, 9, 12)),
      imp(3, at(1, 8, 0)), // 11 days old: not on the list
    ]);
    const s = renderChangesList(read, 0, false, NOW);
    expect(s.text).toBe([
      '*Changes — last 7 days*',
      '',
      '_Oct 12_',
      '1. 14:05 · Imported 2 transactions',
      '_Oct 11_',
      '2. 09:12 · Filed VENMO \\*J SMITH under Dining · -$6.50 · Checking',
    ].join('\n'));
    expect(s.keyboard.inline_keyboard.map((r) => r.map((b) => b.text))).toEqual([['1', '2'], ['Show 1 background change']]);
  });

  it('escapes a bank name with Markdown characters and keeps it out of bold and italics', () => {
    const read = log([filed('SQ *COFFEE_CLUB [2]', at(12, 9, 0), { sfinId: 's', wfId: 'w', name: "Joe's *Visa*" })]);
    const s = renderChangesList(read, 0, false, NOW);
    const line = s.text.split('\n').find((l) => l.startsWith('1. '))!;
    expect(line).toBe("1. 09:00 · Filed SQ \\*COFFEE\\_CLUB \\[2] under Dining · -$6.50 · Joe's \\*Visa\\*");
    // The only entities are the fixed title and the day heading.
    expect(s.text.split('\n').filter((l) => /^[*_]/.test(l))).toEqual(['*Changes — last 7 days*', '_Oct 12_']);
    const detail = renderChangeDetail(read.entries[0], { kind: 'list', page: 0, background: false });
    expect(detail.text.split('\n')[0]).toBe('Filed SQ \\*COFFEE\\_CLUB \\[2] under Dining');
  });

  it('pages by 8, older to the left, with a page count', () => {
    const read = log(Array.from({ length: 10 }, (_, i) => filed(`ROW ${i}`, at(12, 10, i))));
    const first = renderChangesList(read, 0, false, NOW);
    expect(first.text).toContain('Page 1 of 2');
    expect(first.text).toContain('1. 10:09 · Filed ROW 9');
    expect(first.keyboard.inline_keyboard.at(-1)!.map((b) => b.text)).toEqual(['‹ Older']);
    const second = renderChangesList(read, 1, false, NOW);
    expect(second.text).toContain('9. 10:01 · Filed ROW 1');
    expect(second.keyboard.inline_keyboard.at(-1)!.map((b) => b.text)).toEqual(['Newer ›']);
  });

  it('shows background changes when asked, with a way to hide them', () => {
    const read = log([background(at(12, 14, 5))]);
    const s = renderChangesList(read, 0, true, NOW);
    expect(s.text).toContain("1. 14:05 · Marked 1 bookkeeping row as outside transfers for Wealthfolio's Health page · Checking");
    expect(button(s, 'Hide background changes')).toBe('cz:cl:l0');
  });

  it('says so when nothing changed, and leads with gaps, trims and unreadable buckets', () => {
    const s = renderChangesList(log([], {
      gaps: [{ at: at(12, 8, 0).toISOString(), count: 3, reason: "couldn't save the log", writer: 'companion' }], trimmed: 2,
    }), 0, false, NOW);
    expect(s.text).toBe([
      '*Changes — last 7 days*',
      "⚠️ 3 changes may be missing — couldn't save the log Oct 12.",
      '⚠️ 2 older changes were trimmed to keep the log small.',
      '',
      'Nothing changed in the last 7 days.',
    ].join('\n'));
  });

  it('shows at most three notes, then points at the app, and stays under 4096 characters', () => {
    const gaps = Array.from({ length: 50 }, (_, i) => ({
      at: at(12, 8, i).toISOString(), count: 3, reason: "couldn't save the log", writer: 'companion' as const,
    }));
    const s = renderChangesList(log([], { gaps, trimmed: 2 }), 0, false, NOW);
    const notes = s.text.split('\n').filter((l) => l.startsWith('⚠️'));
    expect(notes).toHaveLength(4);
    expect(notes[3]).toBe("⚠️ and 48 more notes — see the app's Change log.");
    expect(s.text.length).toBeLessThan(4096);
    const one = renderChangesList(log([], { gaps: gaps.slice(0, 1), trimmed: 2, unreadable: [
      { writer: 'companion', month: '2026-09', paused: false }, { writer: 'addon', month: '2026-09', paused: false },
    ] as never }), 0, false, NOW);
    expect(one.text).toContain('and 1 more note —');
  });
});

describe('search', () => {
  it('searches the whole log by description, account and category', () => {
    const read = log([filed('VENMO *J SMITH', at(12, 9, 0)), filed('KROGER', at(1, 9, 0)), imp(4, new Date(2026, 8, 20, 9, 0), undefined, 'VENMO CASHOUT')]);
    const s = renderChangesCommand(read, '  venmo  ', NOW);
    expect(s.text.split('\n')[0]).toBe('*Changes matching* venmo');
    expect(s.text).toContain('Filed VENMO \\*J SMITH under Dining');
    expect(s.text).toContain('Imported VENMO CASHOUT');
    expect(s.text).not.toContain('KROGER');
    expect(renderChangesCommand(read, 'zelle', NOW).text).toContain('Nothing in the last 90 days matches zelle.');
  });

  it('skips bookkeeping entries even when their account matches the words', () => {
    const read = log([background(at(12, 14, 5))]);
    const s = renderChangesCommand(read, 'checking', NOW);
    expect(s.text).toContain('Nothing in the last 90 days matches checking.');
    expect(s.text).not.toContain('bookkeeping');
    expect(allData(s)).toEqual([]);
  });

  it('cuts a long search to fit every button under 64 bytes, at a whole character', () => {
    const q = normalizeChangesQuery('ünïcödé ✓ words that go on and on');
    expect(Buffer.byteLength(q, 'utf8')).toBeLessThanOrEqual(30);
    expect(q).toBe('ünïcödé ✓ words that go');
  });
});

describe('callback data', () => {
  it('round-trips every view and stays within 64 bytes', () => {
    const views = [
      { kind: 'list', page: 12, background: true },
      { kind: 'search', page: 3, query: normalizeChangesQuery('ünïcödé ✓ words that go on and on') },
      { kind: 'run', run: 'abcdef01', page: 2, from: { page: 999, background: true } },
      { kind: 'detail', entry: '0123abcd', back: { kind: 'run', run: 'abcdef01', page: 999, from: { page: 999, background: true } } },
      { kind: 'detail', entry: '0123abcd', back: { kind: 'search', page: 999, query: normalizeChangesQuery('ünïcödé ✓ words that go on and on') } },
    ] as const;
    for (const v of views) {
      const data = changesData(v as any);
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
      expect(parseChangesData(data)).toEqual(v);
    }
    expect(parseChangesData('cz:cl:zz')).toBeNull();
    expect(parseChangesData('cz:cl:d0123abcd:d0123abcd:l0')).toBeNull();
  });
});

describe('createChangesMenu', () => {
  const ui = () => ({ edit: vi.fn(async (_t: string, _k?: unknown) => {}), answer: vi.fn(async (_t?: string) => {}) });
  const menuOver = (read: () => Promise<ChangeLogRead>) => createChangesMenu({ read, now: () => NOW, log: vi.fn() });

  it('opens an entry from a button minted before a restart, and goes back to its page', async () => {
    const entry = filed('VENMO *J SMITH', at(11, 9, 12));
    const read = log([entry]);
    const minted = button(renderChangesList(read, 0, false, NOW), '1');
    const u = ui();
    await menuOver(async () => read).onCallback({ data: minted, chatId: 1 }, u);
    const [text, keyboard] = u.edit.mock.calls[0] as [string, any];
    expect(text).toBe([
      'Filed VENMO \\*J SMITH under Dining',
      '-$6.50 · Checking',
      'Before → after: No category → Dining',
      `You, in Telegram · Oct 11, 9:12 AM`,
    ].join('\n'));
    expect(keyboard.inline_keyboard).toEqual([[{ text: '‹ Back', callback_data: 'cz:cl:l0' }]]);
  });

  it('opens a run’s imports, and an import from there goes back to the run', async () => {
    const read = log([imp(1, at(12, 14, 5), 'runA'), imp(2, at(12, 14, 6), 'runA')]);
    const u = ui();
    const menu = menuOver(async () => read);
    await menu.onCallback({ data: button(renderChangesList(read, 0, false, NOW), '1'), chatId: 1 }, u);
    const [runText, runKb] = u.edit.mock.calls[0] as [string, any];
    expect(runText.split('\n')[0]).toBe('*Imported 2 transactions*');
    expect(runText).toContain('1. 14:06 · Imported KROGER #2 · -$12.34 · Checking');
    const runScreen = { text: runText, keyboard: runKb } as MenuScreen;
    await menu.onCallback({ data: button(runScreen, '2'), chatId: 1 }, u);
    const [, detailKb] = u.edit.mock.calls[1] as [string, any];
    expect(parseChangesData(detailKb.inline_keyboard[0][0].callback_data)).toMatchObject({ kind: 'run' });
  });

  it('answers "already sorted" for an entry that has left the log, and shows the list', async () => {
    const gone = filed('OLD ONE', at(11, 9, 0));
    const data = changesData({ kind: 'detail', entry: findingHandle(gone.id), back: { kind: 'list', page: 0, background: false } });
    const u = ui();
    await menuOver(async () => log([])).onCallback({ data, chatId: 1 }, u);
    expect(u.answer).toHaveBeenCalledWith(CHANGES_GONE_ANSWER);
    expect((u.edit.mock.calls[0] as [string])[0]).toContain('Nothing changed in the last 7 days.');
  });

  it('says so when Wealthfolio cannot be reached', async () => {
    const u = ui();
    await menuOver(async () => { throw new Error('ECONNREFUSED'); }).onCallback({ data: 'cz:cl:l0', chatId: 1 }, u);
    expect(u.answer).toHaveBeenCalledWith(CHANGES_UNREACHABLE_REPLY);
    expect(u.edit).not.toHaveBeenCalled();
  });

  it('pages a search without losing the words', async () => {
    const read = log(Array.from({ length: 9 }, (_, i) => filed(`VENMO ${i}`, at(12, 10, i))));
    const first = renderChangesCommand(read, 'venmo', NOW);
    const u = ui();
    await menuOver(async () => read).onCallback({ data: button(first, '‹ Older'), chatId: 1 }, u);
    expect((u.edit.mock.calls[0] as [string])[0]).toContain('9. 10:00 · Filed VENMO 0 under Dining');
  });

  it('marks an entry R2 undid', () => {
    const e = { ...filed('VENMO', at(12, 9, 0)), undone: { by: 'c2', at: at(12, 10, 0).toISOString() } };
    expect(renderChangesList(log([e]), 0, false, NOW).text).toContain('1. 09:00 · Filed VENMO under Dining · -$6.50 · Checking ↩');
  });

  it('names both accounts of a link on its line', () => {
    const link = item(transferLinkChange(
      { account: CHECKING, txKey: 'k1', description: 'CITI AUTOPAY', amountCents: -46460, date: '2026-10-08', oldActivityId: 'o1' },
      { account: { name: 'Citi Card' }, txKey: 'k2', description: 'PAYMENT THANK YOU', amountCents: 46460, date: '2026-10-08', oldActivityId: 'o2' },
    ), at(12, 9, 0));
    expect(renderChangesList(log([link]), 0, false, NOW).text).toContain('· -$464.60 · Checking → Citi Card');
  });

  it('ignores data it never minted', async () => {
    const u = ui();
    await menuOver(async () => log([])).onCallback({ data: 'cz:cl:nonsense', chatId: 1 }, u);
    expect(u.answer).toHaveBeenCalledWith();
    expect(u.edit).not.toHaveBeenCalled();
    expect(allData(renderChangesList(log([]), 0, false, NOW))).toEqual([]);
  });
});
