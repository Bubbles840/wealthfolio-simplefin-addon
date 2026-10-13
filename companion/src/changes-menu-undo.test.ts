import { describe, it, expect, vi } from 'vitest';
import {
  bankUpdateChange, categoryFiledChange, categoryRuleCreatedChange, reversalChange, stampChange, transferLinkChange,
  type ChangeDraft,
} from '../../shared/change-entries.js';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log.js';
import type { UndoOutcome } from '../../shared/change-undo-run.js';
import { findingHandle } from '../../shared/handle.js';
import { normalizeChangesQuery } from './changes-menu.js';
import {
  changesData, CHANGES_GONE_ANSWER, CHANGES_SYNC_RUNNING, CHANGES_SYNC_STARTED, createChangesMenu, parseChangesData,
  renderChangeDetail, type ChangesMenuDeps, type MenuScreen,
} from './changes-menu.js';

const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m);
const NOW = at(13, 15, 0);
const CHECKING = { sfinId: 'ACT-1f2e', wfId: 'wf-checking', name: 'Checking' };
const item = (draft: ChangeDraft, when: Date): ChangeLogItem => stampChange(draft, 'companion', when);
const filed = (desc: string, category = 'Dining') => item(categoryFiledChange({
  actor: 'you', account: CHECKING, activityId: `f-${desc}`, description: desc, amountCents: -650,
  before: null, after: { categoryId: 'cat-din', categoryName: category },
}), at(12, 9, 0));
const link = () => item(transferLinkChange(
  { account: CHECKING, txKey: 'k1', description: 'CITI AUTOPAY', amountCents: -46460, date: '2026-10-08', oldActivityId: 'o1' },
  { account: { name: 'Citi Card', sfinId: 'ACT-9c8d' }, txKey: 'k2', description: 'PAYMENT THANK YOU', amountCents: 46460, date: '2026-10-08', oldActivityId: 'o2' },
), at(12, 10, 0));
const rule = () => item(categoryRuleCreatedChange({ ruleId: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-gro', categoryName: 'Groceries' }), at(12, 11, 0));
const log = (entries: ChangeLogItem[]): ChangeLogRead =>
  ({ entries: [...entries].sort((a, b) => (a.at < b.at ? 1 : -1)), gaps: [], trimmed: 0, unreadable: [] });
const back = { kind: 'list', page: 0, background: false } as const;
const texts = (s: MenuScreen) => s.keyboard.inline_keyboard.map((r) => r.map((b) => b.text));
const button = (s: MenuScreen, text: string) => {
  const b = s.keyboard.inline_keyboard.flat().find((x) => x.text === text);
  if (!b) throw new Error(`no "${text}" among ${s.keyboard.inline_keyboard.flat().map((x) => x.text).join(' | ')}`);
  return b.callback_data;
};
const ui = () => ({
  edit: vi.fn(async (_t: string, _k?: unknown) => {}),
  answer: vi.fn(async (_t?: string) => {}),
  send: vi.fn(async (_t: string) => {}),
});
const lastScreen = (u: ReturnType<typeof ui>): MenuScreen => {
  const [text, keyboard] = u.edit.mock.calls.at(-1) as [string, MenuScreen['keyboard']];
  return { text, keyboard };
};

function menu(reads: ChangeLogRead[], extra: Partial<ChangesMenuDeps> = {}) {
  let i = 0;
  const deps: ChangesMenuDeps = {
    read: vi.fn(async () => reads[Math.min(i++, reads.length - 1)]),
    now: () => NOW,
    log: vi.fn(),
    undo: vi.fn(async (): Promise<UndoOutcome> => ({ ok: true, message: 'Undone — no category.', needsSync: false })),
    ruleFiledCount: vi.fn(async () => 3),
    ...extra,
  };
  return { deps, menu: createChangesMenu(deps) };
}

describe('/changes — Undo and Redo', () => {
  it('an entry’s screen offers ↩ Undo; an undone one offers Redo; a bank change offers neither', async () => {
    const e = filed('VENMO');
    const { menu: m } = menu([log([e])]);
    const u = ui();
    await m.onCallback({ data: changesData({ kind: 'detail', entry: findingHandle(e.id), back }), chatId: 1 }, u);
    expect(texts(lastScreen(u))).toEqual([['↩ Undo'], ['‹ Back']]);

    const undone = { ...e, undone: { by: 'c9', at: at(12, 10, 0).toISOString() } };
    const r = renderChangeDetail(undone, back, { op: 'redo' });
    expect(texts(r)).toEqual([['Redo'], ['‹ Back']]);

    const update = item(bankUpdateChange({
      account: CHECKING, txKey: 'k', activityId: 'a', description: 'X', amountCents: -1,
      before: { absCents: 1, date: '2026-10-01', pending: true, activityType: 'WITHDRAWAL' },
      after: { absCents: 2, date: '2026-10-01', pending: false, activityType: 'WITHDRAWAL' },
    }), at(12, 8, 0));
    const u2 = ui();
    await menu([log([update])]).menu.onCallback({ data: changesData({ kind: 'detail', entry: findingHandle(update.id), back }), chatId: 1 }, u2);
    expect(texts(lastScreen(u2))).toEqual([['‹ Back']]);
  });

  it('a rule offers two undos, with N read when the screen is shown', async () => {
    const r = rule();
    const { menu: m, deps } = menu([log([r])]);
    const u = ui();
    await m.onCallback({ data: changesData({ kind: 'detail', entry: findingHandle(r.id), back }), chatId: 1 }, u);
    expect(texts(lastScreen(u))).toEqual([['↩ Undo rule', '↩ Undo rule + un-file 3'], ['‹ Back']]);
    expect(deps.ruleFiledCount).toHaveBeenCalledWith(r);
    const none = menu([log([r])], { ruleFiledCount: vi.fn(async () => null) });
    const u2 = ui();
    await none.menu.onCallback({ data: changesData({ kind: 'detail', entry: findingHandle(r.id), back }), chatId: 1 }, u2);
    expect(texts(lastScreen(u2))).toEqual([['↩ Undo rule'], ['‹ Back']]);
  });

  it('a tap undoes at once — no confirmation — and the screen says so, now offering Redo', async () => {
    const e = filed('VENMO');
    const undoEntry = stampChange(reversalChange(e, 'undo'), 'companion', at(13, 14, 0));
    const after: ChangeLogRead = { ...log([e, undoEntry]), entries: log([e, undoEntry]).entries.map((x) => (x.id === e.id ? { ...x, undone: { by: undoEntry.id, at: undoEntry.at } } : x)) };
    const { menu: m, deps } = menu([log([e]), after]);
    const u = ui();
    await m.onCallback({ data: changesData({ kind: 'act', action: 'u', entry: findingHandle(e.id), back }), chatId: 1 }, u);
    expect(deps.undo).toHaveBeenCalledWith(expect.objectContaining({ id: e.id }), expect.any(Array), 'undo', 'plain');
    const s = lastScreen(u);
    expect(s.text.split('\n').slice(-2)).toEqual(['', '✅ Undone — no category.']);
    expect(texts(s)).toEqual([['Redo'], ['‹ Back']]);
  });

  it('after a sync decision: "Takes effect on the next sync." and 🔄 Sync now, which runs /sync', async () => {
    const e = link();
    let resolve!: (s: string) => void;
    const summary = new Promise<string>((r) => { resolve = r; });
    const { menu: m, deps } = menu([log([e])], {
      undo: vi.fn(async () => ({ ok: true as const, message: 'Undone — the next sync counts each half as spending or money in.', needsSync: true })),
      syncNow: vi.fn(() => ({ started: true, summary })),
    });
    const u = ui();
    await m.onCallback({ data: changesData({ kind: 'act', action: 'u', entry: findingHandle(e.id), back }), chatId: 1 }, u);
    const s = lastScreen(u);
    expect(s.text).toContain('Takes effect on the next sync.');
    expect(texts(s)).toContainEqual(['🔄 Sync now']);
    await m.onCallback({ data: button(s, '🔄 Sync now'), chatId: 1 }, u);
    expect(deps.syncNow).toHaveBeenCalledTimes(1);
    expect(u.answer).toHaveBeenLastCalledWith(CHANGES_SYNC_STARTED);
    resolve('✅ Synced: 2 imported');
    await summary;
    await Promise.resolve();
    expect(u.send).toHaveBeenCalledWith('✅ Synced: 2 imported');
    const joined = menu([log([e])], { syncNow: vi.fn(() => ({ started: false, summary: Promise.resolve('x') })) });
    const u2 = ui();
    await joined.menu.onCallback({ data: button(s, '🔄 Sync now'), chatId: 1 }, u2);
    expect(u2.answer).toHaveBeenCalledWith(CHANGES_SYNC_RUNNING);
  });

  it('Undo rule + un-file passes the un-file choice', async () => {
    const r = rule();
    const { menu: m, deps } = menu([log([r])]);
    const u = ui();
    await m.onCallback({ data: changesData({ kind: 'act', action: 'f', entry: findingHandle(r.id), back }), chatId: 1 }, u);
    expect(deps.undo).toHaveBeenCalledWith(expect.anything(), expect.any(Array), 'undo', 'unfile');
  });

  it('a refusal is said on the screen, with no Sync now, and a category with Markdown characters stays escaped', async () => {
    const e = filed('SQ *COFFEE_CLUB', 'Food_&_Drink*');
    const { menu: m } = menu([log([e])], {
      undo: vi.fn(async () => ({ ok: false as const, message: 'It has changed since — nothing was undone.' })),
    });
    const u = ui();
    await m.onCallback({ data: changesData({ kind: 'act', action: 'u', entry: findingHandle(e.id), back }), chatId: 1 }, u);
    const s = lastScreen(u);
    expect(s.text).toContain('⚠️ It has changed since — nothing was undone.');
    expect(texts(s)).toEqual([['↩ Undo'], ['‹ Back']]);
    const ok = renderChangeDetail(e, back, { result: { ok: true, message: 'Undone — filed under Food_&_Drink*.' } });
    expect(ok.text).toContain('✅ Undone — filed under Food\\_&\\_Drink\\*.');
    expect(ok.text.split('\n').filter((l) => /^[*_]/.test(l))).toEqual([]);
  });

  it('an entry gone from the log answers "already sorted"', async () => {
    const e = filed('GONE');
    const { menu: m, deps } = menu([log([])]);
    const u = ui();
    await m.onCallback({ data: changesData({ kind: 'act', action: 'u', entry: findingHandle(e.id), back }), chatId: 1 }, u);
    expect(u.answer).toHaveBeenCalledWith(CHANGES_GONE_ANSWER);
    expect(deps.undo).not.toHaveBeenCalled();
  });

  it('a menu built without undo stays read-only, as in R1', async () => {
    const e = filed('VENMO');
    const m = createChangesMenu({ read: async () => log([e]), now: () => NOW, log: vi.fn() });
    const u = ui();
    await m.onCallback({ data: changesData({ kind: 'detail', entry: findingHandle(e.id), back }), chatId: 1 }, u);
    expect(texts(lastScreen(u))).toEqual([['‹ Back']]);
    await m.onCallback({ data: changesData({ kind: 'act', action: 'u', entry: findingHandle(e.id), back }), chatId: 1 }, u);
    expect(u.answer).toHaveBeenLastCalledWith();
  });

  it('every action button round-trips and fits in 64 bytes, behind the longest back', () => {
    const longest = [
      { kind: 'search', page: 999, query: normalizeChangesQuery('ünïcödé ✓ words that go on and on') },
      { kind: 'run', run: 'abcdef01', page: 999, from: { page: 999, background: true } },
    ] as const;
    for (const b of longest) {
      for (const action of ['u', 'r', 'f', 's'] as const) {
        const v = { kind: 'act', action, entry: '0123abcd', back: b } as const;
        const data = changesData(v as any);
        expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
        expect(parseChangesData(data)).toEqual(v);
      }
    }
    expect(parseChangesData('cz:cl:xu0123abcd:d0123abcd:l0')).toBeNull();
  });
});
