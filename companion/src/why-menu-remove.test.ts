import { describe, it, expect, vi } from 'vitest';
import { escapeMarkdown } from '../../shared/telegram.js';
import { buildTxStory, TX_STORY_GONE, type TxStoryFacts } from '../../shared/tx-story.js';
import {
  removalFingerprint, REMOVE_CHANGED, REMOVE_CONFIRM, REMOVE_DONE, REMOVE_NO_UNDO, removeUnsure, type RemoveOutcome,
} from '../../shared/tx-remove.js';
import { createWhyMenu, parseWhyData, renderWhyRemoveConfirm, renderWhyStory, whyData, type MenuScreen, type WhyMenuDeps } from './why-menu.js';
import type { StoryOutcome } from './tx-story-host.js';

const ID = '0f8fad5b-d9cb-469f-a165-708677289501';
const NOW = new Date('2026-10-14T16:00:00Z');
const BANK = 'SQ *COFFEE_CLUB [2]';
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const allData = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
const labels = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.text);

const facts = (over: Partial<TxStoryFacts> = {}, note = `${BANK} · TRN-600`): TxStoryFacts => ({
  now: NOW,
  row: { activityId: ID, note, absCents: 60000, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking' },
  feed: { sfinAccountId: 'sfin-chk' }, partner: null, history: [], ...over,
});
const ok = (f: TxStoryFacts = facts()): StoryOutcome => ({ kind: 'ok', story: buildTxStory(f), facts: f });
const FP = removalFingerprint(facts().row);

function deps(over: Partial<WhyMenuDeps> = {}): WhyMenuDeps {
  return {
    search: vi.fn(),
    story: vi.fn(async () => ok()),
    read: vi.fn(),
    remove: vi.fn(async (): Promise<RemoveOutcome> => ({ ok: true, message: REMOVE_DONE })),
    now: () => NOW,
    log: vi.fn(),
    ...over,
  };
}
const ui = () => ({ edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) });
const edited = (u: ReturnType<typeof ui>) => u.edit.mock.calls.at(-1) as unknown as [string, MenuScreen['keyboard']];

describe('the cz:wy: remove buttons', () => {
  it('parse back, and the longest fits 64 bytes with a 36-character id', () => {
    const ask = whyData({ kind: 'remove-ask', activityId: ID });
    const remove = whyData({ kind: 'remove', activityId: ID, fingerprint: FP });
    expect(parseWhyData(ask)).toEqual({ kind: 'remove-ask', activityId: ID });
    expect(parseWhyData(remove)).toEqual({ kind: 'remove', activityId: ID, fingerprint: FP });
    const confirm = renderWhyRemoveConfirm(buildTxStory(facts()), ID, FP);
    const data = [ask, ...allData(confirm)];
    expect(Math.max(...data.map(bytes))).toBe(52);
    for (const bad of [`cz:wy:D${ID}`, `cz:wy:D${ID}:XYZ`, 'cz:wy:d']) expect(parseWhyData(bad)).toBeNull();
  });
});

describe('Remove for good… on a /why story', () => {
  it('shows on a story that qualifies, only when the menu can remove', async () => {
    const story = buildTxStory(facts());
    expect(labels(renderWhyStory(story, ID, { kind: 'none' }, { removable: true }))).toEqual(['Remove for good…']);
    const u = ui();
    await createWhyMenu(deps()).onCallback({ data: whyData({ kind: 'story', activityId: ID, back: { kind: 'changes' } }) }, u);
    expect(edited(u)[1].inline_keyboard.flat().map((b) => b.callback_data)).toContain(`cz:wy:d${ID}`);
    const v = ui();
    await createWhyMenu(deps({ remove: undefined })).onCallback({ data: whyData({ kind: 'story', activityId: ID, back: { kind: 'changes' } }) }, v);
    expect(edited(v)[1].inline_keyboard.flat().map((b) => b.text)).not.toContain('Remove for good…');
    const w = ui();
    await createWhyMenu(deps({ story: vi.fn(async () => ok(facts({}, `${BANK} · TRN-600 · pending`))) }))
      .onCallback({ data: whyData({ kind: 'story', activityId: ID, back: { kind: 'changes' } }) }, w);
    expect(edited(w)[1].inline_keyboard.flat().map((b) => b.text)).not.toContain('Remove for good…');
  });

  it('the first tap edits the story into the confirm screen: the exact words, Remove, and Cancel back to the story', async () => {
    const d = deps();
    const u = ui();
    await createWhyMenu(d).onCallback({ data: `cz:wy:d${ID}` }, u);
    const [text, kb] = edited(u);
    expect(text).toBe([`🔎 ${escapeMarkdown(`${BANK} · $600.00 · Oct 9`)}`, 'PNC Checking', '', escapeMarkdown(REMOVE_CONFIRM)].join('\n'));
    expect(kb.inline_keyboard).toEqual([
      [{ text: 'Remove', callback_data: `cz:wy:D${ID}:${FP}` }],
      [{ text: 'Cancel', callback_data: `cz:wy:t${ID}:c` }],
    ]);
    expect(d.remove).not.toHaveBeenCalled();
    const back = ui();
    await createWhyMenu(d).onCallback({ data: kb.inline_keyboard[1][0].callback_data }, back);
    expect(edited(back)[0].startsWith(`🔎 ${escapeMarkdown(`${BANK} · $600.00 · Oct 9`)}\nPNC Checking\n`)).toBe(true);
  });

  it('Remove removes it and says so in place, with nothing left to tap', async () => {
    const d = deps();
    const u = ui();
    await createWhyMenu(d).onCallback({ data: `cz:wy:D${ID}:${FP}` }, u);
    expect(d.remove).toHaveBeenCalledWith(ID, FP, NOW);
    expect(edited(u)).toEqual([`🔎 ${escapeMarkdown(REMOVE_DONE)}`, { inline_keyboard: [] }]);
  });

  it('a refused Remove shows the story again, as it is now, with why on top', async () => {
    const d = deps({ remove: vi.fn(async () => ({ ok: false, message: REMOVE_CHANGED })) });
    const u = ui();
    await createWhyMenu(d).onCallback({ data: `cz:wy:D${ID}:${FP}` }, u);
    const [text] = edited(u);
    expect(text.startsWith(`⚠️ ${escapeMarkdown(REMOVE_CHANGED)}\n🔎 `)).toBe(true);
    const gone = deps({ remove: vi.fn(async () => ({ ok: false, message: REMOVE_CHANGED })), story: vi.fn(async (): Promise<StoryOutcome> => ({ kind: 'gone' })) });
    const v = ui();
    await createWhyMenu(gone).onCallback({ data: `cz:wy:D${ID}:${FP}` }, v);
    expect(edited(v)).toEqual([`⚠️ ${escapeMarkdown(REMOVE_CHANGED)}`, { inline_keyboard: [] }]);
  });

  it('answers a first tap on a row that is gone', async () => {
    const u = ui();
    await createWhyMenu(deps({ story: vi.fn(async (): Promise<StoryOutcome> => ({ kind: 'gone' })) })).onCallback({ data: `cz:wy:d${ID}` }, u);
    expect(u.answer).toHaveBeenCalledWith(TX_STORY_GONE);
    expect(u.edit).not.toHaveBeenCalled();
  });
});

describe('raw bank and Wealthfolio text in a removal outcome', () => {
  it('escapes _ and * from the row note and the error, outside every entity', async () => {
    const note = 'SQ *COFFEE_CLUB [2] · TRN-600';
    const msgs = [
      removeUnsure('timeout_x *y*', `Checking · $600.00 · ${note}`),
      `Couldn't remove it (bad_gateway *502*) — nothing was changed.`,
    ];
    for (const message of msgs) {
      const u = ui();
      await createWhyMenu(deps({ remove: vi.fn(async () => ({ ok: false, message })), story: vi.fn(async (): Promise<StoryOutcome> => ({ kind: 'gone' })) })).onCallback({ data: `cz:wy:D${ID}:${FP}` }, u);
      expect(edited(u)[0]).toBe(`⚠️ ${escapeMarkdown(message)}`);
      expect(edited(u)[0]).not.toMatch(/(^|[^\\])[_*]/);
      const f = facts({}, note);
      const v = ui();
      await createWhyMenu(deps({ remove: vi.fn(async () => ({ ok: false, message })), story: vi.fn(async () => ok(f)) })).onCallback({ data: `cz:wy:D${ID}:${removalFingerprint(f.row)}` }, v);
      const text = edited(v)[0];
      expect(text.startsWith(`⚠️ ${escapeMarkdown(message)}\n🔎 `)).toBe(true);
      // the only unescaped * or _ would be an entity opener: none is allowed
      const notice = text.slice(0, text.indexOf('\n🔎 '));
      expect(notice.replace(/\\[_*`[]/g, '')).not.toMatch(/[_*`[]/);
      // the story's own row note is escaped too, wherever it appears
      expect(text).toContain(escapeMarkdown(note.split(' · ')[0]));
    }
  });
  it('an ok REMOVE_NO_UNDO renders alone, nothing to tap', async () => {
    const u = ui();
    await createWhyMenu(deps({ remove: vi.fn(async () => ({ ok: true, message: REMOVE_NO_UNDO })) })).onCallback({ data: `cz:wy:D${ID}:${FP}` }, u);
    expect(edited(u)).toEqual([`🔎 ${escapeMarkdown(REMOVE_NO_UNDO)}`, { inline_keyboard: [] }]);
  });
  it('stays within 4096 characters when the raw parts are huge', async () => {
    const message = `Couldn't remove it (${'_x*'.repeat(3000)}) — nothing was changed.`;
    for (const gone of [true, false]) {
      const u = ui();
      await createWhyMenu(deps({
        remove: vi.fn(async () => ({ ok: false, message })),
        story: vi.fn(async (): Promise<StoryOutcome> => (gone ? { kind: 'gone' } : ok())),
      })).onCallback({ data: `cz:wy:D${ID}:${FP}` }, u);
      expect(edited(u)[0].length).toBeLessThanOrEqual(4096);
      expect(edited(u)[0].startsWith('⚠️ ')).toBe(true);
    }
    const u = ui();
    await createWhyMenu(deps({ remove: vi.fn(async () => ({ ok: true, message: 'x_'.repeat(5000) })) })).onCallback({ data: `cz:wy:D${ID}:${FP}` }, u);
    expect(edited(u)[0].length).toBeLessThanOrEqual(4096);
  });
});
